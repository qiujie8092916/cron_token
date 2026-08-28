import {
  type ExecutionReporter,
  formatError,
  Logger,
  sleep,
  type AttemptFailure,
  type ScheduledRunner,
  type Trigger,
} from "@scheduler/shared";
import type { TokenConfig } from "./config.js";

interface PricingModel {
  readonly model_name?: unknown;
  readonly model_price?: unknown;
  readonly model_ratio?: unknown;
  readonly quota_type?: unknown;
}

export class AttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The model attempt exceeded its timeout of ${timeoutMs} ms.`);
    this.name = "AttemptTimeoutError";
  }
}

export class TokenRunner implements ScheduledRunner {
  readonly #config: TokenConfig;
  readonly #logger: Logger;
  readonly #reporter: ExecutionReporter;
  #activeController: AbortController | undefined;
  #shuttingDown = false;

  constructor(config: TokenConfig, logger: Logger, reporter: ExecutionReporter) {
    this.#config = config;
    this.#logger = logger;
    this.#reporter = reporter;
  }

  async run(trigger: Trigger): Promise<void> {
    const startedAt = new Date();
    const failures: AttemptFailure[] = [];
    let models: readonly string[];

    try {
      models = await this.#resolveModels();
    } catch (error) {
      if (this.#shuttingDown) return;
      failures.push({ model: "model-discovery", error: this.#logger.redact(formatError(error)) });
      await this.#reportFailure(trigger, startedAt, ["dynamic model discovery"], failures);
      return;
    }

    this.#logger.info(`execution started trigger=${trigger} models=${models.join(",")}`);
    for (const [index, model] of models.entries()) {
      try {
        this.#logger.info(`attempt=${index + 1}/${models.length} model=${model} started`);
        const answer = await this.#withAttemptTimeout((signal) => this.#requestChat(model, signal));
        const endedAt = new Date();
        this.#logger.result(`model=${model} elapsed_ms=${endedAt.getTime() - startedAt.getTime()} answer=${answer}`);
        try {
          await this.#reporter.success({
            answer,
            attemptNumber: index + 1,
            configuredModels: models,
            elapsedMs: endedAt.getTime() - startedAt.getTime(),
            endedAt,
            endpoint: `${this.#config.domain}/v1/chat/completions`,
            failures,
            model,
            prompt: this.#config.content,
            service: "Token",
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
        if (this.#shuttingDown) return;
        const formatted = this.#logger.redact(formatError(error));
        failures.push({ model, error: formatted });
        this.#logger.warn(`attempt=${index + 1}/${models.length} model=${model} failed error=${formatted}`);
        if (index < models.length - 1) await sleep(this.#config.retryDelayMs);
      }
    }

    await this.#reportFailure(trigger, startedAt, models, failures);
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#activeController?.abort(new Error("The active Token request was cancelled during shutdown."));
  }

  async #resolveModels(): Promise<readonly string[]> {
    if (this.#config.models) return this.#config.models;
    const models = await this.#withAttemptTimeout((signal) => this.#requestPricingModels(signal));
    this.#logger.info(`MODELS is blank; dynamically selected models=${models.join(",")}`);
    return models;
  }

  async #requestPricingModels(signal: AbortSignal): Promise<readonly string[]> {
    const response = await fetch(`${this.#config.domain}/api/pricing`, {
      headers: { Authorization: `Bearer ${this.#config.apiKey}` },
      signal,
    });
    const payload = await readJsonResponse(response, "Pricing API");
    if (isRecord(payload) && (payload.error || payload.success === false)) {
      throw new Error(`Pricing API returned an error: ${JSON.stringify(payload.error ?? payload)}`);
    }
    return selectLowestPricedModels(isRecord(payload) ? payload.data : undefined, this.#config.modelsCount);
  }

  async #requestChat(model: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${this.#config.domain}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        temperature: 1,
        model,
        messages: [{ role: "user", content: this.#config.content }],
      }),
      signal,
    });
    const payload = await readJsonResponse(response, "Chat API");
    if (isRecord(payload) && payload.error) {
      throw new Error(`Chat API returned an error: ${JSON.stringify(payload.error)}`);
    }
    const answer = extractAssistantAnswer(payload);
    return answer ?? JSON.stringify(payload);
  }

  async #withAttemptTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.#activeController = controller;
    const timeout = setTimeout(() => {
      controller.abort(new AttemptTimeoutError(this.#config.attemptTimeoutMs));
    }, this.#config.attemptTimeoutMs);
    try {
      return await operation(controller.signal);
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

  async #reportFailure(
    trigger: Trigger,
    startedAt: Date,
    configuredModels: readonly string[],
    failures: readonly AttemptFailure[],
  ): Promise<void> {
    const endedAt = new Date();
    try {
      await this.#reporter.failure({
        configuredModels,
        elapsedMs: endedAt.getTime() - startedAt.getTime(),
        endedAt,
        endpoint: `${this.#config.domain}/v1/chat/completions`,
        failures,
        service: "Token",
        startedAt,
        timeZone: this.#config.timeZone,
        trigger,
      });
      this.#logger.info("failure notification sent");
    } catch (error) {
      this.#logger.error(`failure notification failed error=${this.#logger.redact(formatError(error))}`);
    }
  }
}

export function pricingSortValue(model: PricingModel): number {
  const value = model.quota_type === 0 ? model.model_ratio : model.model_price;
  return typeof value === "number" ? value : 0;
}

export function selectLowestPricedModels(data: unknown, count: number): readonly string[] {
  if (!Array.isArray(data)) throw new Error("Pricing API data is not an array.");
  const models = (data as PricingModel[])
    .filter((item) => typeof item?.model_name === "string" && item.model_name.trim())
    .sort((left, right) => pricingSortValue(left) - pricingSortValue(right))
    .slice(0, count)
    .map((item) => (item.model_name as string).trim());
  if (models.length === 0) throw new Error("Pricing API returned no usable models.");
  return models;
}

export function extractAssistantAnswer(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  return typeof first.message.content === "string" ? first.message.content : null;
}

async function readJsonResponse(response: Response, label: string): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status} ${response.statusText}: ${body.slice(0, 1000)}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON: ${body.slice(0, 1000)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
