import {
  accessTokenFromEnv,
  query,
  type Query,
} from "@qoder-ai/qoder-agent-sdk";
import type { AppConfig } from "./config.js";
import { formatError, type Logger } from "./logger.js";

export interface JobRun {
  readonly id: number;
  readonly triggeredAt: Date;
  readonly trigger: "cron" | "startup";
}

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The job exceeded its total timeout of ${timeoutMs} ms.`);
    this.name = "RequestTimeoutError";
  }
}

export class ShutdownError extends Error {
  constructor() {
    super("The active job was cancelled because the scheduler is shutting down.");
    this.name = "ShutdownError";
  }
}

export class QoderRunner {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  #activeController: AbortController | undefined;
  #activeQuery: Query | undefined;

  constructor(config: AppConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
  }

  async run(job: JobRun): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const failures: Array<{ readonly error: string; readonly model: string }> = [];
    this.#activeController = controller;

    const timeout = setTimeout(() => {
      if (controller.signal.aborted) {
        return;
      }

      const error = new RequestTimeoutError(this.#config.requestTimeoutMs);
      controller.abort(error);
      this.#logger.error(`job=${job.id} ${error.message}`);
      void this.#interruptQuery(job.id, "timeout");
    }, this.#config.requestTimeoutMs);

    this.#logger.info(
      `job=${job.id} started trigger=${job.trigger} triggered_at=${job.triggeredAt.toISOString()} ` +
        `models=${this.#config.models.join(",")}`,
    );

    try {
      for (const [index, model] of this.#config.models.entries()) {
        throwIfAborted(controller.signal);

        const attempt = index + 1;
        this.#logger.info(
          `job=${job.id} attempt=${attempt}/${this.#config.models.length} model=${model} started`,
        );

        try {
          const answer = await this.#runModel(model, controller.signal);
          throwIfAborted(controller.signal);

          const elapsedMs = Date.now() - startedAt;
          this.#logger.info(
            `job=${job.id} completed model=${model} elapsed_ms=${elapsedMs}`,
          );
          this.#logger.result(job.id, model, elapsedMs, answer);
          return;
        } catch (error) {
          if (controller.signal.aborted) {
            throw abortReason(controller.signal);
          }

          const formattedError = this.#logger.redact(formatError(error));
          failures.push({ error: formattedError, model });

          this.#logger.warn(
            `job=${job.id} attempt=${attempt}/${this.#config.models.length} model=${model} ` +
              `failed error=${formattedError}`,
          );

          const hasNextModel = index < this.#config.models.length - 1;
          if (hasNextModel) {
            this.#logger.info(
              `job=${job.id} retrying next_model=${this.#config.models[index + 1]} ` +
                `delay_ms=${this.#config.retryDelayMs}`,
            );
            await abortableDelay(this.#config.retryDelayMs, controller.signal);
          }
        }
      }

      const elapsedMs = Date.now() - startedAt;
      this.#logger.error(
        `job=${job.id} failed all_models=${this.#config.models.join(",")} elapsed_ms=${elapsedMs} ` +
          `failures=${JSON.stringify(failures)}`,
      );
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (error instanceof ShutdownError) {
        this.#logger.warn(`job=${job.id} cancelled elapsed_ms=${elapsedMs}`);
        return;
      }

      this.#logger.error(
        `job=${job.id} stopped elapsed_ms=${elapsedMs} error=${this.#logger.redact(formatError(error))}`,
      );
    } finally {
      clearTimeout(timeout);
      if (this.#activeController === controller) {
        this.#activeController = undefined;
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.#activeController) {
      return;
    }

    if (!this.#activeController.signal.aborted) {
      this.#activeController.abort(new ShutdownError());
    }

    await this.#interruptQuery(undefined, "shutdown");
  }

  async #runModel(model: string, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);

    const currentQuery = query({
      prompt: this.#config.content,
      options: {
        auth: accessTokenFromEnv("ACCESS_TOKEN"),
        cwd: this.#config.projectRoot,
        model,
        persistSession: false,
        settingSources: [],
        skills: [],
        tools: [],
        stderr: (data) => {
          const message = data.trim();
          if (message) {
            this.#logger.warn(`qoder_stderr=${this.#logger.redact(message)}`);
          }
        },
      },
    });

    this.#activeQuery = currentQuery;

    try {
      for await (const message of currentQuery) {
        throwIfAborted(signal);

        if (message.type !== "result") {
          continue;
        }

        if (message.subtype === "success") {
          return message.result;
        }

        throw new Error(
          message.errors.length > 0
            ? message.errors.join("; ")
            : `Qoder returned ${message.subtype}.`,
        );
      }

      throwIfAborted(signal);
      throw new Error("Qoder ended the session without returning a result.");
    } finally {
      if (this.#activeQuery === currentQuery) {
        this.#activeQuery = undefined;
      }
    }
  }

  async #interruptQuery(jobId: number | undefined, reason: string): Promise<void> {
    const currentQuery = this.#activeQuery;
    if (!currentQuery) {
      return;
    }

    try {
      await currentQuery.interrupt();
      this.#logger.info(
        `${jobId === undefined ? "" : `job=${jobId} `}qoder query interrupted reason=${reason}`.trim(),
      );
    } catch (error) {
      this.#logger.warn(
        `${jobId === undefined ? "" : `job=${jobId} `}qoder interrupt failed reason=${reason} ` +
          `error=${this.#logger.redact(formatError(error))}`,
      );
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The operation was aborted.");
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  if (durationMs === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
