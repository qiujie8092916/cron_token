import cron from "node-cron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { JobQueue } from "./job-queue.js";
import { formatError, Logger } from "./logger.js";
import { QoderRunner } from "./qoder-runner.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const config = loadConfig(projectRoot);
  const logger = new Logger(process.env.ACCESS_TOKEN);
  const runner = new QoderRunner(config, logger);
  const queue = new JobQueue(runner, logger);

  const scheduledTask = cron.schedule(
    config.cronExpression,
    () => {
      queue.enqueue("cron");
    },
    { timezone: config.timeZone },
  );

  logger.info(
    `scheduler started cron=${JSON.stringify(config.cronExpression)} timezone=${config.timeZone} ` +
      `run_on_start=${config.runOnStart} models=${config.models.join(",")} ` +
      `request_timeout_ms=${config.requestTimeoutMs} retry_delay_ms=${config.retryDelayMs}`,
  );

  if (config.runOnStart) {
    queue.enqueue("startup");
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      logger.warn(`signal=${signal} ignored because shutdown is already in progress`);
      return;
    }

    shuttingDown = true;
    logger.info(`signal=${signal} shutdown started`);
    scheduledTask.stop();

    const discarded = await queue.shutdown();
    logger.info(`shutdown completed discarded_jobs=${discarded}`);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  const logger = new Logger(process.env.ACCESS_TOKEN);
  logger.error(`startup failed error=${logger.redact(formatError(error))}`);
  process.exitCode = 1;
});
