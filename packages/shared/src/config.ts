import cron from "node-cron";

export interface MailConfig {
  readonly from: string;
  readonly host: string;
  readonly pass?: string;
  readonly port: number;
  readonly secure: boolean;
  readonly to: string;
  readonly user?: string;
}

export interface DingTalkConfig {
  readonly atAllOnFailure: boolean;
  readonly secret?: string;
  readonly webhookUrl: string;
}

export type NotificationChannel = "email" | "dingtalk";

export interface SchedulerConfig {
  readonly attemptTimeoutMs: number;
  readonly content: string;
  readonly cronExpression: string;
  readonly dingtalk?: DingTalkConfig;
  readonly mail?: MailConfig;
  readonly notificationChannels: readonly NotificationChannel[];
  readonly retryDelayMs: number;
  readonly runOnStart: boolean;
  readonly timeZone: string;
}

export function loadSchedulerConfig(): SchedulerConfig {
  const cronExpression = requiredEnv("CRON");
  const timeZone = optionalEnv("TZ") ?? "Asia/Shanghai";
  validateCron(cronExpression);
  validateTimeZone(timeZone);

  const notificationChannels = notificationChannelsEnv();
  const mail = notificationChannels.includes("email") ? loadMailConfig() : undefined;
  const dingtalk = notificationChannels.includes("dingtalk") ? loadDingTalkConfig() : undefined;

  return {
    attemptTimeoutMs: integerEnv("ATTEMPT_TIMEOUT_MS", 30_000, 1),
    content: requiredEnv("CONTENT", false),
    cronExpression,
    ...(dingtalk ? { dingtalk } : {}),
    ...(mail ? { mail } : {}),
    notificationChannels,
    retryDelayMs: integerEnv("RETRY_DELAY_MS", 5_000, 0),
    runOnStart: booleanEnv("RUN_ON_START", false),
    timeZone,
  };
}

function loadMailConfig(): MailConfig {
  const user = optionalEnv("SMTP_USER");
  const pass = process.env.SMTP_PASS;
  if (user && !pass) {
    throw new Error("SMTP_PASS is required when SMTP_USER is configured.");
  }
  return {
    from: requiredEnv("MAIL_FROM"),
    host: requiredEnv("SMTP_HOST"),
    port: integerEnv("SMTP_PORT", 587, 1),
    secure: booleanEnv("SMTP_SECURE", false),
    to: requiredEnv("MAIL_TO"),
    ...(user ? { user, pass: pass as string } : {}),
  };
}

function loadDingTalkConfig(): DingTalkConfig {
  const webhookUrl = requiredEnv("DINGTALK_WEBHOOK_URL");
  try {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("DINGTALK_WEBHOOK_URL must be a valid HTTPS URL.");
  }
  const secret = optionalEnv("DINGTALK_SECRET");
  return {
    atAllOnFailure: booleanEnv("DINGTALK_AT_ALL_ON_FAILURE", true),
    ...(secret ? { secret } : {}),
    webhookUrl,
  };
}

function notificationChannelsEnv(): readonly NotificationChannel[] {
  const raw = optionalEnv("NOTIFY_CHANNELS") ?? "email";
  const channels = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (channels.length === 0 || channels.some((channel) => channel !== "email" && channel !== "dingtalk")) {
    throw new Error("NOTIFY_CHANNELS must contain email, dingtalk, or both as a comma-separated list.");
  }
  return channels as NotificationChannel[];
}

export function requiredEnv(name: string, trim = true): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is missing or blank.`);
  }
  return trim ? value.trim() : value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function parseModels(
  raw: string | undefined,
  defaults?: readonly string[],
): readonly string[] | null {
  if (raw === undefined || raw.trim().length === 0) {
    return defaults ? [...defaults] : null;
  }

  const models = raw.split(",").map((model) => model.trim()).filter(Boolean);
  if (models.length === 0) {
    return defaults ? [...defaults] : null;
  }
  return models;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be exactly true or false.`);
}

function integerEnv(name: string, fallback: number, minimum: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function validateCron(expression: string): void {
  if (expression.split(/\s+/).length !== 5 || !cron.validate(expression)) {
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
