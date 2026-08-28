import type { SchedulerConfig } from "./config.js";
import { DingTalkReporter } from "./dingtalk.js";
import { EmailReporter, type ExecutionReporter, type FailureReport, type SkippedReport, type SuccessReport } from "./mail.js";

export class CompositeReporter implements ExecutionReporter {
  readonly #reporters: readonly ExecutionReporter[];

  constructor(reporters: readonly ExecutionReporter[]) {
    if (reporters.length === 0) throw new Error("At least one execution reporter is required.");
    this.#reporters = reporters;
  }

  async success(report: SuccessReport): Promise<void> {
    await this.#run((reporter) => reporter.success(report));
  }

  async failure(report: FailureReport): Promise<void> {
    await this.#run((reporter) => reporter.failure(report));
  }

  async skipped(report: SkippedReport): Promise<void> {
    await this.#run((reporter) => reporter.skipped(report));
  }

  async #run(operation: (reporter: ExecutionReporter) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(this.#reporters.map(operation));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      const details = errors.map((error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      throw new AggregateError(errors, `${errors.length} notification channel(s) failed: ${details.join("; ")}`);
    }
  }
}

export function createExecutionReporter(config: SchedulerConfig): ExecutionReporter {
  const reporters = config.notificationChannels.map((channel): ExecutionReporter => {
    if (channel === "email") {
      if (!config.mail) throw new Error("Email notification configuration is missing.");
      return new EmailReporter(config.mail);
    }
    if (!config.dingtalk) throw new Error("DingTalk notification configuration is missing.");
    return new DingTalkReporter(config.dingtalk);
  });
  return reporters.length === 1 ? reporters[0] as ExecutionReporter : new CompositeReporter(reporters);
}
