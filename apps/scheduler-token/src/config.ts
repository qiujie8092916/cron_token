import {
  loadSchedulerConfig,
  optionalEnv,
  parseModels,
  requiredEnv,
  type SchedulerConfig,
} from "@scheduler/shared";

export interface TokenConfig extends SchedulerConfig {
  readonly apiKey: string;
  readonly domain: string;
  readonly models: readonly string[] | null;
  readonly modelsCount: number;
}

export function loadTokenConfig(): TokenConfig {
  const common = loadSchedulerConfig();
  const domain = requiredEnv("DOMAIN").replace(/\/+$/, "");
  try {
    const url = new URL(domain);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("DOMAIN must be a valid HTTP(S) URL.");
  }

  return {
    ...common,
    apiKey: requiredEnv("API_KEY"),
    domain,
    models: parseModels(process.env.MODELS),
    modelsCount: positiveInteger("MODELS_COUNT", optionalEnv("MODELS_COUNT"), 5),
  };
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}
