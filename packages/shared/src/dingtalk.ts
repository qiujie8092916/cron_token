import { createHmac } from "node:crypto";
import type { DingTalkConfig } from "./config.js";
import {
  type ExecutionReporter,
  formatInTimeZone,
  type FailureReport,
  type SkippedReport,
  type SuccessReport,
  truncate,
} from "./mail.js";

interface DingTalkResponse {
  readonly errcode?: unknown;
  readonly errmsg?: unknown;
}

export interface DingTalkMessage {
  readonly at: { readonly isAtAll: boolean };
  readonly markdown: { readonly text: string; readonly title: string };
  readonly msgtype: "markdown";
}

export class DingTalkReporter implements ExecutionReporter {
  readonly #config: DingTalkConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(config: DingTalkConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async success(report: SuccessReport): Promise<void> {
    await this.#send(renderSuccessDingTalk(report));
  }

  async failure(report: FailureReport): Promise<void> {
    await this.#send(renderFailureDingTalk(report, this.#config.atAllOnFailure));
  }

  async skipped(report: SkippedReport): Promise<void> {
    await this.#send(renderSkippedDingTalk(report));
  }

  async #send(message: DingTalkMessage): Promise<void> {
    const response = await this.#fetch(signedWebhookUrl(this.#config, this.#now()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`DingTalk webhook HTTP ${response.status} ${response.statusText}: ${truncate(body, 500)}`);
    }
    let result: DingTalkResponse;
    try {
      result = JSON.parse(body) as DingTalkResponse;
    } catch {
      throw new Error(`DingTalk webhook did not return valid JSON: ${truncate(body, 500)}`);
    }
    if (result.errcode !== 0) {
      throw new Error(`DingTalk webhook rejected the message: errcode=${String(result.errcode)} errmsg=${String(result.errmsg ?? "")}`);
    }
  }
}

export function renderSuccessDingTalk(report: SuccessReport): DingTalkMessage {
  const failures = report.failures.length === 0
    ? "无"
    : report.failures.map((failure) => `${failure.model}: ${truncate(singleLine(failure.error), 200)}`).join("；");
  return markdownMessage(
    `【Scheduler ${report.service}】Success ✅ ${singleLine(report.model)}`,
    [
      ["服务", report.service],
      ["触发方式", report.trigger],
      ["配置模型", report.configuredModels.join(", ")],
      ["成功模型", report.model],
      ["尝试序号", String(report.attemptNumber)],
      ["前序失败", failures],
      ...(report.endpoint ? [["接口地址", report.endpoint] as const] : []),
      ["开始时间", formatInTimeZone(report.startedAt, report.timeZone)],
      ["结束时间", formatInTimeZone(report.endedAt, report.timeZone)],
      ["总耗时", `${report.elapsedMs} ms`],
      ["用户", truncate(singleLine(report.prompt), 100)],
      ["助手", truncate(singleLine(report.answer), 500)],
    ],
    false,
  );
}

export function renderFailureDingTalk(report: FailureReport, atAll: boolean): DingTalkMessage {
  const details = report.failures
    .map((failure) => `${failure.model}: ${truncate(singleLine(failure.error), 500)}`)
    .join("；");
  return markdownMessage(
    `【Scheduler ${report.service}】Failed ❌`,
    [
      ["服务", report.service],
      ["触发方式", report.trigger],
      ["配置模型", report.configuredModels.join(", ")],
      ["尝试次数", String(report.failures.length)],
      ["失败详情", details || "无"],
      ...(report.endpoint ? [["接口地址", report.endpoint] as const] : []),
      ["开始时间", formatInTimeZone(report.startedAt, report.timeZone)],
      ["结束时间", formatInTimeZone(report.endedAt, report.timeZone)],
      ["总耗时", `${report.elapsedMs} ms`],
    ],
    atAll,
  );
}

export function renderSkippedDingTalk(report: SkippedReport): DingTalkMessage {
  return markdownMessage(
    `【Scheduler ${report.service}】Skipped ⏭️`,
    [
      ["服务", report.service],
      ["触发方式", report.trigger],
      ["跳过原因", "上一次任务仍在执行。"],
      ["时间", formatInTimeZone(report.time, report.timeZone)],
    ],
    false,
  );
}

export function signedWebhookUrl(config: DingTalkConfig, timestamp: number): string {
  const url = new URL(config.webhookUrl);
  if (!config.secret) return url.toString();
  const sign = createHmac("sha256", config.secret).update(`${timestamp}\n${config.secret}`).digest("base64");
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url.toString();
}

function markdownMessage(
  title: string,
  rows: readonly (readonly [string, string])[],
  atAll: boolean,
): DingTalkMessage {
  const text = [`### ${escapeMarkdown(title)}`, "", ...rows.map(([label, value]) => `- **${escapeMarkdown(label)}：** ${escapeMarkdown(value)}`)];
  if (atAll) text.push("", "@所有人");
  return {
    at: { isAtAll: atAll },
    markdown: { title, text: text.join("\n") },
    msgtype: "markdown",
  };
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replace(/([`*_{}\[\]()#+.!|>-])/g, "\\$1");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
