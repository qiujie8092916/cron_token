import path from "node:path";
import { EmailReporter, formatError, Logger, startScheduler } from "@scheduler/shared";
import { loadQoderConfig } from "./config.js";
import { QoderRunner } from "./qoder-runner.js";

function main(): void {
  const config = loadQoderConfig(path.resolve(process.cwd()));
  const logger = new Logger([config.accessToken, config.mail.pass]);
  const reporter = new EmailReporter(config.mail);
  const runner = new QoderRunner(config, logger, reporter);

  startScheduler({
    cronExpression: config.cronExpression,
    logger,
    onSkipped: (trigger) => reporter.skipped({
      service: "Qoder",
      time: new Date(),
      timeZone: config.timeZone,
      trigger,
    }),
    runOnStart: config.runOnStart,
    runner,
    timeZone: config.timeZone,
  });
}

try {
  main();
} catch (error) {
  console.error(`[${new Date().toISOString()}] [ERROR] startup failed error=${formatError(error)}`);
  process.exitCode = 1;
}
