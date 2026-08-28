import { accessTokenFromEnv, query } from "@qoder-ai/qoder-agent-sdk";
import {
  type ExecutionReporter,
  formatError,
  Logger,
  sleep,
  throwIfAborted,
  type AttemptFailure,
  type ScheduledRunner,
  type Trigger,
} from "@scheduler/shared";
import type { QoderConfig } from "./config.js";

export class AttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The model attempt exceeded its timeout of ${timeoutMs} ms.`);
    this.name = "AttemptTimeoutError";
  }
}

export class ShutdownError extends Error {
  constructor() {
    super("The active Qoder attempt was cancelled during shutdown.");
    this.name = "ShutdownError";
  }
}

interface QoderMessage {
  readonly errors?: readonly string[];
  readonly result?: string;
  readonly subtype?: string;
  readonly type: string;
}
export interface QoderQuery extends AsyncIterable<QoderMessage> {
  interrupt(): Promise<void>;
}
export type QoderQueryFactory = (model: string, prompt: string, projectRoot: string, logger: Logger) => QoderQuery;

export class QoderRunner implements ScheduledRunner {
  readonly #config: QoderConfig;
  readonly #logger: Logger;
  readonly #reporter: ExecutionReporter;
  readonly #queryFactory: QoderQueryFactory;
  #activeController: AbortController | undefined;
  #activeQuery: QoderQuery | undefined;

  constructor(
    config: QoderConfig,
    logger: Logger,
    reporter: ExecutionReporter,
    queryFactory: QoderQueryFactory = createQoderQuery,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#reporter = reporter;
    this.#queryFactory = queryFactory;
  }

  async run(trigger: Trigger): Promise<void> {
    const startedAt = new Date();
    const failures: AttemptFailure[] = [];
    this.#logger.info(`execution started trigger=${trigger} models=${this.#config.models.join(",")}`);

    for (const [index, model] of this.#config.models.entries()) {
      try {
        this.#logger.info(`attempt=${index + 1}/${this.#config.models.length} model=${model} started`);
        const answer = await this.#runAttempt(model);
        const endedAt = new Date();
        this.#logger.result(`model=${model} elapsed_ms=${endedAt.getTime() - startedAt.getTime()} answer=${answer}`);
        try {
          await this.#reporter.success({
            answer,
            attemptNumber: index + 1,
            configuredModels: this.#config.models,
            elapsedMs: endedAt.getTime() - startedAt.getTime(),
            endedAt,
            failures,
            model,
            prompt: this.#config.content,
            service: "Qoder",
            startedAt,
            timeZone: this.#config.timeZone,
            trigger,
          });
          this.#logger.info("success notification sent");
        } catch (error) {
          this.#logger.error(`success notification failed error=${this.#logger.redact(formatError(error))}`);
        }
        return;
      } catch (error) {
        if (error instanceof ShutdownError) {
          this.#logger.warn("execution cancelled during shutdown");
          return;
        }
        const formatted = this.#logger.redact(formatError(error));
        failures.push({ model, error: formatted });
        this.#logger.warn(`attempt=${index + 1}/${this.#config.models.length} model=${model} failed error=${formatted}`);
        if (index < this.#config.models.length - 1) {
          try {
            await this.#abortableRetryDelay();
          } catch (delayError) {
            if (delayError instanceof ShutdownError) return;
            throw delayError;
          }
        }
      }
    }

    const endedAt = new Date();
    try {
      await this.#reporter.failure({
        configuredModels: this.#config.models,
        elapsedMs: endedAt.getTime() - startedAt.getTime(),
        endedAt,
        failures,
        service: "Qoder",
        startedAt,
        timeZone: this.#config.timeZone,
        trigger,
      });
      this.#logger.info("failure notification sent");
    } catch (error) {
      this.#logger.error(`failure notification failed error=${this.#logger.redact(formatError(error))}`);
    }
  }

  async shutdown(): Promise<void> {
    this.#activeController?.abort(new ShutdownError());
    await this.#interruptQuery("shutdown");
  }

  async #runAttempt(model: string): Promise<string> {
    const controller = new AbortController();
    this.#activeController = controller;
    const timeout = setTimeout(() => {
      controller.abort(new AttemptTimeoutError(this.#config.attemptTimeoutMs));
      void this.#interruptQuery("timeout");
    }, this.#config.attemptTimeoutMs);
    try {
      return await this.#runModel(model, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.#activeController === controller) this.#activeController = undefined;
    }
  }

  async #runModel(model: string, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const currentQuery = this.#queryFactory(model, this.#config.content, this.#config.projectRoot, this.#logger);
    this.#activeQuery = currentQuery;
    try {
      for await (const message of currentQuery) {
        throwIfAborted(signal);
        if (message.type !== "result") continue;
        if (message.subtype === "success" && typeof message.result === "string") return message.result;
        const errors = message.errors ?? [];
        throw new Error(errors.length > 0 ? errors.join("; ") : `Qoder returned ${message.subtype ?? "an unknown result"}.`);
      }
      throwIfAborted(signal);
      throw new Error("Qoder ended the session without returning a result.");
    } finally {
      if (this.#activeQuery === currentQuery) this.#activeQuery = undefined;
    }
  }

  async #abortableRetryDelay(): Promise<void> {
    const controller = new AbortController();
    this.#activeController = controller;
    try {
      await sleep(this.#config.retryDelayMs, controller.signal);
    } finally {
      if (this.#activeController === controller) this.#activeController = undefined;
    }
  }

  async #interruptQuery(reason: string): Promise<void> {
    const currentQuery = this.#activeQuery;
    if (!currentQuery) return;
    try {
      await currentQuery.interrupt();
      this.#logger.info(`qoder query interrupted reason=${reason}`);
    } catch (error) {
      this.#logger.warn(`qoder interrupt failed reason=${reason} error=${this.#logger.redact(formatError(error))}`);
    }
  }
}

function createQoderQuery(model: string, prompt: string, projectRoot: string, logger: Logger): QoderQuery {
  return query({
    prompt,
    options: {
      auth: accessTokenFromEnv("ACCESS_TOKEN"),
      cwd: projectRoot,
      model,
      persistSession: false,
      settingSources: [],
      skills: [],
      tools: [],
      stderr: (data) => {
        const message = data.trim();
        if (message) logger.warn(`qoder_stderr=${logger.redact(message)}`);
      },
    },
  }) as QoderQuery;
}
