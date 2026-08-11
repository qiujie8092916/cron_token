const cron = require('node-cron');
const nodemailer = require('nodemailer');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少必填环境变量：${name}`);
  return value;
}

function nonNegativeInteger(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必须是非负整数`);
  return Number(raw);
}

function positiveInteger(name, fallback) {
  const value = nonNegativeInteger(name, fallback);
  if (value === 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function booleanValue(name, fallback) {
  const raw = (process.env[name] ?? String(fallback)).toLowerCase();
  if (!['true', 'false'].includes(raw)) throw new Error(`${name} 必须是 true 或 false`);
  return raw === 'true';
}

function loadConfig() {
  const domain = required('DOMAIN').replace(/\/+$/, '');
  try {
    const url = new URL(domain);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error('DOMAIN 必须是有效的 http(s) URL');
  }

  const schedule = process.env.CRON?.trim() || '0 10 * * *';
  if (!cron.validate(schedule)) throw new Error(`CRON 表达式无效：${schedule}`);

  const smtpUser = process.env.SMTP_USER?.trim();
  const smtpPass = process.env.SMTP_PASS;
  if (smtpUser && !smtpPass) throw new Error('配置 SMTP_USER 时必须同时配置 SMTP_PASS');

  return {
    domain,
    apiKey: required('API_KEY'),
    model: process.env.MODEL?.trim() || 'Qwen3.6-35B-A3B-FP8',
    content: process.env.CONTENT ?? '你好',
    retryCount: nonNegativeInteger('RETRY_COUNT', 3),
    retryDelayMs: positiveInteger('RETRY_DELAY_MS', 5000),
    requestTimeoutMs: positiveInteger('REQUEST_TIMEOUT_MS', 30000),
    schedule,
    timezone: process.env.TZ?.trim() || 'Asia/Shanghai',
    runOnStart: booleanValue('RUN_ON_START', false),
    smtp: {
      host: required('SMTP_HOST'),
      port: positiveInteger('SMTP_PORT', 587),
      secure: booleanValue('SMTP_SECURE', false),
      user: smtpUser,
      pass: smtpPass,
    },
    mailFrom: required('MAIL_FROM'),
    mailTo: required('MAIL_TO'),
  };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestChat(config) {
  const response = await fetch(`${config.domain}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      stream: false,
      temperature: 1,
      model: config.model,
      messages: [{ role: 'user', content: config.content }],
    }),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 1000)}`);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`接口未返回有效 JSON：${body.slice(0, 1000)}`);
  }
  if (data?.error) throw new Error(`接口返回错误：${JSON.stringify(data.error)}`);
  return data;
}

function createMailer(config) {
  const auth = config.smtp.user
    ? { user: config.smtp.user, pass: config.smtp.pass }
    : undefined;
  return nodemailer.createTransport({ ...config.smtp, auth });
}

async function sendSuccessEmail(config, attempt) {
  const transporter = createMailer(config);
  await transporter.sendMail({
    from: config.mailFrom,
    to: config.mailTo,
    subject: '【Cron Token】Success ✅',
    text: [
      `第 ${attempt} 次请求成功。`,
      `此前重试次数：${attempt - 1}`,
      `时间：${new Date().toISOString()}`,
      `接口：${config.domain}/v1/chat/completions`,
    ].join('\n'),
  });
}

async function sendFailureEmail(config, errors) {
  const transporter = createMailer(config);
  const attempted = errors.length;
  const details = errors.map((error, index) => `第 ${index + 1} 次：${error}`).join('\n');

  await transporter.sendMail({
    from: config.mailFrom,
    to: config.mailTo,
    subject: '【Cron Token】Fail ❌',
    text: [
      `重试了 ${Math.max(0, attempted - 1)} 次，最终失败了。`,
      `时间：${new Date().toISOString()}`,
      `接口：${config.domain}/v1/chat/completions`,
      `总请求次数：${attempted}`,
      '',
      '失败详情：',
      details,
    ].join('\n'),
  });
}

let running = false;

async function run(config) {
  if (running) {
    console.warn(`[${new Date().toISOString()}] 上一次任务尚未结束，本次跳过`);
    return;
  }

  running = true;
  const errors = [];
  const maxAttempts = config.retryCount + 1;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        console.log(`[${new Date().toISOString()}] 开始第 ${attempt}/${maxAttempts} 次请求`);
        const data = await requestChat(config);
        console.log(`[${new Date().toISOString()}] 请求成功`, JSON.stringify(data));
        try {
          await sendSuccessEmail(config, attempt);
          console.log(`[${new Date().toISOString()}] 成功邮件已发送`);
        } catch (error) {
          console.error(`[${new Date().toISOString()}] 成功邮件发送失败：`, error);
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        console.error(`[${new Date().toISOString()}] 第 ${attempt}/${maxAttempts} 次请求失败：${message}`);
        if (attempt < maxAttempts) await sleep(config.retryDelayMs);
      }
    }

    try {
      await sendFailureEmail(config, errors);
      console.log(`[${new Date().toISOString()}] 告警邮件已发送`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] 告警邮件发送失败：`, error);
    }
  } finally {
    running = false;
  }
}

function main() {
  const config = loadConfig();
  cron.schedule(config.schedule, () => void run(config), {
    timezone: config.timezone,
    noOverlap: true,
  });
  console.log(`服务已启动；计划：${config.schedule}；时区：${config.timezone}`);
  if (config.runOnStart) {
    console.log('RUN_ON_START=true，立即执行一次任务');
    void run(config);
  }
}

try {
  main();
} catch (error) {
  console.error('服务启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
}
