import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInTimeZone,
  loadSchedulerConfig,
  parseModels,
  renderFailureEmail,
  renderSuccessEmail,
  truncate,
} from "@scheduler/shared";

test("parseModels preserves configured duplicates and order", () => {
  assert.deepEqual(parseModels("lite, auto, lite"), ["lite", "auto", "lite"]);
});

test("parseModels uses defaults for missing or blank input", () => {
  assert.deepEqual(parseModels("  ", ["lite", "auto"]), ["lite", "auto"]);
  assert.equal(parseModels(undefined), null);
});

test("truncate keeps the configured characters and appends an ellipsis", () => {
  assert.equal(truncate("一二三四", 3), "一二三…");
  assert.equal(truncate("一二三", 3), "一二三");
});

test("formatInTimeZone follows the configured timezone", () => {
  const date = new Date("2026-08-28T00:00:00.000Z");
  assert.equal(formatInTimeZone(date, "Asia/Shanghai"), "2026-08-28 08:00:00 Asia/Shanghai");
  assert.equal(formatInTimeZone(date, "UTC"), "2026-08-28 00:00:00 UTC");
});

test("common config requires CONTENT and CRON and permits a zero retry delay", () => {
  const original = { ...process.env };
  Object.assign(process.env, {
    CONTENT: "prompt",
    CRON: "0 10 * * *",
    RETRY_DELAY_MS: "0",
    SMTP_HOST: "smtp.example.com",
    MAIL_FROM: "from@example.com",
    MAIL_TO: "to@example.com",
  });
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  try {
    assert.equal(loadSchedulerConfig().retryDelayMs, 0);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
  }
});

test("HTML success mail escapes content, truncates it, and includes preceding failures", () => {
  const message = renderSuccessEmail({
    answer: `${"答".repeat(101)}<b>`,
    attemptNumber: 2,
    configuredModels: ["first", "second"],
    elapsedMs: 10,
    endedAt: new Date("2026-08-28T00:00:01Z"),
    failures: [{ model: "first", error: "bad <response>" }],
    model: "second",
    prompt: "<script>alert(1)</script>",
    service: "Qoder",
    startedAt: new Date("2026-08-28T00:00:00Z"),
    timeZone: "Asia/Shanghai",
    trigger: "cron",
  });
  assert.equal(message.subject, "【Scheduler Qoder】Success ✅ second");
  assert.match(message.html, />服务</);
  assert.match(message.html, />成功模型</);
  assert.match(message.html, />用户</);
  assert.match(message.html, />助手</);
  assert.match(message.html, /bad &lt;response&gt;/);
  assert.doesNotMatch(message.html, /<script>/);
  assert.match(message.html, /答{100}…/);
});

test("failure mail excludes user and assistant fields", () => {
  const message = renderFailureEmail({
    configuredModels: ["first"],
    elapsedMs: 10,
    endedAt: new Date("2026-08-28T00:00:01Z"),
    failures: [{ model: "first", error: "bad" }],
    service: "Token",
    startedAt: new Date("2026-08-28T00:00:00Z"),
    timeZone: "Asia/Shanghai",
    trigger: "missed",
  });
  assert.equal(message.subject, "【Scheduler Token】Failed ❌");
  assert.doesNotMatch(message.html, />用户</);
  assert.doesNotMatch(message.html, />助手</);
  assert.match(message.html, />失败详情</);
});
