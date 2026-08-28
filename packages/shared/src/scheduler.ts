import cron, { type ScheduledTask } from "node-cron";
import type { Logger } from "./logger.js";
import type { Trigger } from "./mail.js";

export interface ScheduledRunner {
  run(trigger: Trigger): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SchedulerOptions {
  readonly cronExpression: string;
  readonly logger: Logger;
  readonly onSkipped: (trigger: Trigger) => Promise<void>;
  readonly runOnStart: boolean;
  readonly runner: ScheduledRunner;
  readonly timeZone: string;
}

export function startScheduler(options: SchedulerOptions): void {
  let active: Promise<void> | undefined;
  let shuttingDown = false;

  const trigger = (source: Trigger): void => {
    if (shuttingDown) return;
    if (active) {
      options.logger.warn(`trigger=${source} skipped because previous execution is still running`);
      void options.onSkipped(source).catch((error: unknown) => {
        options.logger.error(`skipped email failed error=${options.logger.redact(error)}`);
      });
      return;
    }

    active = options.runner.run(source)
      .catch((error: unknown) => {
        options.logger.error(`execution crashed error=${options.logger.redact(error)}`);
      })
      .finally(() => {
        active = undefined;
      });
  };

  const task: ScheduledTask = cron.schedule(options.cronExpression, () => trigger("cron"), {
    timezone: options.timeZone,
  });
  task.on("execution:missed", () => {
    options.logger.warn("cron execution was missed; running catch-up execution immediately");
    trigger("missed");
  });

  options.logger.info(
    `scheduler started cron=${JSON.stringify(options.cronExpression)} timezone=${options.timeZone} run_on_start=${options.runOnStart}`,
  );
  if (options.runOnStart) trigger("startup");

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.logger.info(`signal=${signal} shutdown started`);
    task.stop();
    await options.runner.shutdown();
    await active;
    options.logger.info("shutdown completed");
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
