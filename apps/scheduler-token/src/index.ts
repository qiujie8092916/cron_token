import { EmailReporter, formatError, Logger, startScheduler } from "@scheduler/shared";
import { loadTokenConfig } from "./config.js";
import { TokenRunner } from "./token-runner.js";

function main(): void {
  const config = loadTokenConfig();
  const logger = new Logger([config.apiKey, config.mail.pass]);
  const reporter = new EmailReporter(config.mail);
  const runner = new TokenRunner(config, logger, reporter);

  startScheduler({
    cronExpression: config.cronExpression,
    logger,
    onSkipped: (trigger) => reporter.skipped({
      service: "Token",
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
