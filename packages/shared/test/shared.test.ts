import test from "node:test";
import assert from "node:assert/strict";
import {
  CompositeReporter,
  DingTalkReporter,
  formatInTimeZone,
  loadSchedulerConfig,
  parseModels,
  renderFailureDingTalk,
  renderFailureEmail,
  renderSuccessEmail,
  signedWebhookUrl,
  type ExecutionReporter,
  type FailureReport,
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
    NOTIFY_CHANNELS: "email",
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

test("DingTalk-only config does not require SMTP settings", () => {
  const original = { ...process.env };
  Object.assign(process.env, {
    CONTENT: "prompt",
    CRON: "0 10 * * *",
    DINGTALK_AT_ALL_ON_FAILURE: "false",
    DINGTALK_SECRET: "SEC-secret",
    DINGTALK_WEBHOOK_URL: "https://oapi.dingtalk.com/robot/send?access_token=token",
    NOTIFY_CHANNELS: "dingtalk",
  });
  delete process.env.SMTP_HOST;
  delete process.env.MAIL_FROM;
  delete process.env.MAIL_TO;
  try {
    const config = loadSchedulerConfig();
    assert.deepEqual(config.notificationChannels, ["dingtalk"]);
    assert.equal(config.mail, undefined);
    assert.equal(config.dingtalk?.atAllOnFailure, false);
    assert.equal(config.dingtalk?.secret, "SEC-secret");
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

function failureReport(): FailureReport {
  return {
    configuredModels: ["first"],
    elapsedMs: 10,
    endedAt: new Date("2026-08-28T00:00:01Z"),
    failures: [{ model: "first", error: "bad *response*\nwith details" }],
    service: "Token",
    startedAt: new Date("2026-08-28T00:00:00Z"),
    timeZone: "Asia/Shanghai",
    trigger: "cron",
  };
}

test("DingTalk failure message escapes content and can notify everyone", () => {
  const message = renderFailureDingTalk(failureReport(), true);
  assert.equal(message.msgtype, "markdown");
  assert.equal(message.at.isAtAll, true);
  assert.match(message.markdown.text, /@所有人/);
  assert.ok(message.markdown.text.includes("bad \\*response\\* with details"));
  assert.doesNotMatch(message.markdown.text, /\nwith details/);
});

test("DingTalk signed webhook uses timestamp and HMAC signature", () => {
  const url = new URL(signedWebhookUrl({
    atAllOnFailure: true,
    secret: "SEC-secret",
    webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=token",
  }, 123456789));
  assert.equal(url.searchParams.get("access_token"), "token");
  assert.equal(url.searchParams.get("timestamp"), "123456789");
  assert.ok(url.searchParams.get("sign"));
});

test("DingTalk reporter rejects HTTP success with a business error", async () => {
  const mockFetch = (async () => new Response(JSON.stringify({ errcode: 310000, errmsg: "sign not match" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;
  const reporter = new DingTalkReporter({
    atAllOnFailure: true,
    webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=token",
  }, mockFetch);
  await assert.rejects(reporter.failure(failureReport()), /errcode=310000/);
});

test("composite reporter still invokes every channel when one fails", async () => {
  let delivered = false;
  const failing: ExecutionReporter = {
    async success() { throw new Error("failed"); },
    async failure() { throw new Error("failed"); },
    async skipped() { throw new Error("failed"); },
  };
  const working: ExecutionReporter = {
    async success() { delivered = true; },
    async failure() { delivered = true; },
    async skipped() { delivered = true; },
  };
  const reporter = new CompositeReporter([failing, working]);
  await assert.rejects(reporter.failure(failureReport()), /1 notification channel/);
  assert.equal(delivered, true);
});
