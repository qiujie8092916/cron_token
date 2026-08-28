import nodemailer, { type Transporter } from "nodemailer";
import type { MailConfig } from "./config.js";

export type ServiceName = "Token" | "Qoder";
export type Trigger = "cron" | "startup" | "missed";

export interface AttemptFailure {
  readonly error: string;
  readonly model: string;
}

interface BaseReport {
  readonly configuredModels: readonly string[];
  readonly elapsedMs: number;
  readonly endedAt: Date;
  readonly endpoint?: string;
  readonly service: ServiceName;
  readonly startedAt: Date;
  readonly timeZone: string;
  readonly trigger: Trigger;
}

export interface SuccessReport extends BaseReport {
  readonly answer: string;
  readonly attemptNumber: number;
  readonly failures: readonly AttemptFailure[];
  readonly model: string;
  readonly prompt: string;
}

export interface FailureReport extends BaseReport {
  readonly failures: readonly AttemptFailure[];
}

export interface SkippedReport {
  readonly service: ServiceName;
  readonly time: Date;
  readonly timeZone: string;
  readonly trigger: Trigger;
}

export interface ExecutionReporter {
  success(report: SuccessReport): Promise<void>;
  failure(report: FailureReport): Promise<void>;
  skipped(report: SkippedReport): Promise<void>;
}

export class EmailReporter implements ExecutionReporter {
  readonly #transporter: Transporter;
  readonly #config: MailConfig;

  constructor(config: MailConfig) {
    this.#config = config;
    const auth = config.user ? { user: config.user, pass: config.pass } : undefined;
    this.#transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(auth ? { auth } : {}),
    });
  }

  async success(report: SuccessReport): Promise<void> {
    const message = renderSuccessEmail(report);
    await this.#send(message.subject, message.html);
  }

  async failure(report: FailureReport): Promise<void> {
    const message = renderFailureEmail(report);
    await this.#send(message.subject, message.html);
  }

  async skipped(report: SkippedReport): Promise<void> {
    const message = renderSkippedEmail(report);
    await this.#send(message.subject, message.html);
  }

  async #send(subject: string, html: string): Promise<void> {
    await this.#transporter.sendMail({
      from: this.#config.from,
      to: this.#config.to,
      subject,
      html,
    });
  }
}

export function renderSuccessEmail(report: SuccessReport): { readonly html: string; readonly subject: string } {
  const precedingFailures = report.failures.length === 0 ? "None" : failureList(report.failures);
  return {
    subject: `【Scheduler ${report.service}】Success ✅ ${subjectValue(report.model)}`,
    html: page("Execution succeeded", "success", [
      row("Service", report.service),
      row("Trigger", report.trigger),
      row("Configured models", report.configuredModels.join(", ")),
      row("Successful model", report.model),
      row("Attempt number", String(report.attemptNumber)),
      row("Previous failed attempts", String(report.failures.length)),
      row("Previous failure details", precedingFailures, true),
      ...(report.endpoint ? [row("Endpoint", report.endpoint)] : []),
      row("Started", formatInTimeZone(report.startedAt, report.timeZone)),
      row("Finished", formatInTimeZone(report.endedAt, report.timeZone)),
      row("Elapsed", `${report.elapsedMs} ms`),
      row("user", truncate(report.prompt, 100), false, true),
      row("assistant", truncate(report.answer, 100), false, true),
    ]),
  };
}

export function renderFailureEmail(report: FailureReport): { readonly html: string; readonly subject: string } {
  return {
    subject: `【Scheduler ${report.service}】Failed ❌`,
    html: page("Execution failed", "failed", [
      row("Service", report.service),
      row("Trigger", report.trigger),
      row("Configured models", report.configuredModels.join(", ")),
      row("Attempted models", report.failures.map((failure) => failure.model).join(", ")),
      row("Attempt count", String(report.failures.length)),
      row("Failure details", failureList(report.failures), true),
      ...(report.endpoint ? [row("Endpoint", report.endpoint)] : []),
      row("Started", formatInTimeZone(report.startedAt, report.timeZone)),
      row("Finished", formatInTimeZone(report.endedAt, report.timeZone)),
      row("Elapsed", `${report.elapsedMs} ms`),
    ]),
  };
}

export function renderSkippedEmail(report: SkippedReport): { readonly html: string; readonly subject: string } {
  return {
    subject: `【Scheduler ${report.service}】Skipped ⏭️`,
    html: page("Execution skipped", "skipped", [
      row("Service", report.service),
      row("Trigger", report.trigger),
      row("Reason", "The previous execution is still running."),
      row("Time", formatInTimeZone(report.time, report.timeZone)),
    ]),
  };
}

export function truncate(value: string, maximum: number): string {
  const characters = [...value];
  return characters.length > maximum ? `${characters.slice(0, maximum).join("")}…` : value;
}

export function formatInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")} ${timeZone}`;
}

function failureList(failures: readonly AttemptFailure[]): string {
  if (failures.length === 0) return "None";
  return `<ol>${failures.map((failure) =>
    `<li><strong>${escapeHtml(failure.model)}</strong><pre>${escapeHtml(truncate(failure.error, 500))}</pre></li>`
  ).join("")}</ol>`;
}

function row(label: string, value: string, trustedHtml = false, preformatted = false): string {
  const escaped = trustedHtml ? value : escapeHtml(value);
  const rendered = preformatted ? `<pre>${escaped}</pre>` : escaped;
  return `<tr><th>${escapeHtml(label)}</th><td>${rendered}</td></tr>`;
}

function page(title: string, status: string, rows: readonly string[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;color:#1f2937;background:#f3f4f6;padding:24px}.card{max-width:800px;margin:auto;background:#fff;border-radius:10px;overflow:hidden}.header{padding:20px 24px;background:#111827;color:#fff}.header h1{margin:0;font-size:22px}.status{margin-top:6px;text-transform:uppercase;color:#d1d5db}table{width:100%;border-collapse:collapse}th,td{padding:12px 16px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}th{width:210px;background:#f9fafb}pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0}ol{margin:0;padding-left:20px}</style></head><body><div class="card"><div class="header"><h1>${escapeHtml(title)}</h1><div class="status">${escapeHtml(status)}</div></div><table>${rows.join("")}</table></div></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function subjectValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
