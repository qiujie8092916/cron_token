import { config as loadDotenv } from "dotenv";
import cron from "node-cron";
import path from "node:path";

export interface AppConfig {
  readonly content: string;
  readonly cronExpression: string;
  readonly models: readonly string[];
  readonly projectRoot: string;
  readonly requestTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly runOnStart: boolean;
  readonly timeZone: string;
}

const DEFAULTS = {
  requestTimeoutMs: 30_000,
  retryDelayMs: 5_000,
  runOnStart: false,
  timeZone: "Asia/Shanghai",
} as const;

export function loadConfig(projectRoot: string): AppConfig {
  const dotenvResult = loadDotenv({
    path: path.join(projectRoot, ".env"),
    quiet: true,
  });

  if (
    dotenvResult.error &&
    (dotenvResult.error as NodeJS.ErrnoException).code !== "ENOENT"
  ) {
    throw new Error(`Unable to load .env: ${dotenvResult.error.message}`);
  }

  requireNonBlank("ACCESS_TOKEN");

  const content = requireNonBlank("CONTENT", false);
  const cronExpression = requireNonBlank("CRON");
  const models = parseModels(requireNonBlank("MODELS"));
  const timeZone = readOptional("TZ") ?? DEFAULTS.timeZone;
  const runOnStart = parseBoolean(
    "RUN_ON_START",
    readOptional("RUN_ON_START"),
    DEFAULTS.runOnStart,
  );
  const requestTimeoutMs = parseInteger(
    "REQUEST_TIMEOUT_MS",
    readOptional("REQUEST_TIMEOUT_MS"),
    DEFAULTS.requestTimeoutMs,
    1,
  );
  const retryDelayMs = parseInteger(
    "RETRY_DELAY_MS",
    readOptional("RETRY_DELAY_MS"),
    DEFAULTS.retryDelayMs,
    0,
  );

  validateCron(cronExpression);
  validateTimeZone(timeZone);

  return {
    content,
    cronExpression,
    models,
    projectRoot,
    requestTimeoutMs,
    retryDelayMs,
    runOnStart,
    timeZone,
  };
}

function requireNonBlank(name: string, trim = true): string {
  const value = process.env[name];

  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is missing or blank.`);
  }

  return trim ? value.trim() : value;
}

function readOptional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
}

function parseModels(raw: string): readonly string[] {
  const models = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];

  if (models.length === 0) {
    throw new Error("MODELS must contain at least one non-empty model value.");
  }

  return models;
}

function parseBoolean(
  name: string,
  raw: string | undefined,
  defaultValue: boolean,
): boolean {
  if (raw === undefined) {
    return defaultValue;
  }

  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  throw new Error(`${name} must be exactly true or false.`);
}

function parseInteger(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  minimum: number,
): number {
  if (raw === undefined) {
    return defaultValue;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }

  return parsed;
}

function validateCron(expression: string): void {
  const fields = expression.split(/\s+/);
  if (fields.length !== 5 || !cron.validate(expression)) {
    throw new Error("CRON must be a valid standard five-field cron expression.");
  }
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`TZ must be a valid IANA time zone; received ${JSON.stringify(timeZone)}.`);
  }
}
