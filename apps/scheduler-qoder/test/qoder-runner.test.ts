import test from "node:test";
import assert from "node:assert/strict";
import {
  Logger,
  type ExecutionReporter,
  type FailureReport,
  type SkippedReport,
  type SuccessReport,
} from "@scheduler/shared";
import { DEFAULT_QODER_MODELS, type QoderConfig } from "@scheduler/qoder/config";
import {
  QoderRunner,
  type QoderQuery,
  type QoderQueryFactory,
} from "@scheduler/qoder/qoder-runner";

function config(overrides: Partial<QoderConfig> = {}): QoderConfig {
  return {
    accessToken: "secret",
    attemptTimeoutMs: 100,
    content: "prompt",
    cronExpression: "0 10 * * *",
    mail: { from: "from@example.com", host: "smtp.example.com", port: 587, secure: false, to: "to@example.com" },
    models: ["first", "second"],
    notificationChannels: ["email"],
    projectRoot: "/tmp",
    retryDelayMs: 0,
    runOnStart: false,
    timeZone: "Asia/Shanghai",
    ...overrides,
  };
}

function reporter(): ExecutionReporter & {
  reports: {
    failures: FailureReport[];
    skipped: SkippedReport[];
    successes: SuccessReport[];
  };
} {
  const reports = {
    failures: [] as FailureReport[],
    skipped: [] as SkippedReport[],
    successes: [] as SuccessReport[],
  };
  return {
    reports,
    async failure(value) { reports.failures.push(value); },
    async skipped(value) { reports.skipped.push(value); },
    async success(value) { reports.successes.push(value); },
  };
}

function resultQuery(message: {
  readonly errors?: readonly string[];
  readonly result?: string;
  readonly subtype: string;
  readonly type: string;
}): QoderQuery {
  return {
    async interrupt() {},
    async *[Symbol.asyncIterator]() { yield message; },
  };
}

test("Qoder default model order is stable", () => {
  assert.deepEqual([...DEFAULT_QODER_MODELS], ["lite", "efficient", "auto", "performance", "ultimate"]);
});

test("Qoder runner reports preceding failures when a later model succeeds", async () => {
  const mail = reporter();
  const factory: QoderQueryFactory = (model) => model === "first"
    ? resultQuery({ type: "result", subtype: "error", errors: ["failed first"] })
    : resultQuery({ type: "result", subtype: "success", result: "worked" });
  const runner = new QoderRunner(config(), new Logger(["secret"]), mail, factory);
  await runner.run("cron");
  assert.equal(mail.reports.failures.length, 0);
  assert.equal(mail.reports.successes.length, 1);
  assert.equal(mail.reports.successes[0]?.model, "second");
  assert.equal(mail.reports.successes[0]?.failures.length, 1);
});

test("Qoder runner applies timeout independently to one model attempt", async () => {
  const mail = reporter();
  const factory: QoderQueryFactory = () => {
    let finish: ((result: IteratorResult<never>) => void) | undefined;
    return {
      async interrupt() { finish?.({ done: true, value: undefined as never }); },
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<never>>((resolve) => { finish = resolve; }),
        };
      },
    };
  };
  const runner = new QoderRunner(config({ attemptTimeoutMs: 5, models: ["slow"] }), new Logger(), mail, factory);
  await runner.run("cron");
  assert.equal(mail.reports.failures.length, 1);
  assert.match(mail.reports.failures[0]?.failures[0]?.error ?? "", /AttemptTimeoutError/);
});
