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

function modelsValue() {
  const raw = process.env.MODELS?.trim();
  if (!raw) return null;

  const models = raw.split(',').map((model) => model.trim());
  if (models.some((model) => !model)) {
    throw new Error('MODELS 必须是用英文逗号分隔的非空模型名列表');
  }
  return models;
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
    models: modelsValue(),
    modelsCount: positiveInteger('MODELS_COUNT', 5),
    content: process.env.CONTENT ?? '你好',
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

function pricingSortValue(model) {
  return model.quota_type === 0 ? model.model_ratio : model.model_price || 0;
}

function selectLowestPricedModels(data, count) {
  if (!Array.isArray(data)) throw new Error('价格接口的 data 不是数组');

  const models = data
    .filter((item) => item && typeof item.model_name === 'string' && item.model_name.trim())
    .sort((left, right) => pricingSortValue(left) - pricingSortValue(right))
    .slice(0, count)
    .map((item) => item.model_name.trim());

  if (models.length === 0) throw new Error('价格接口没有返回可用模型');
  return models;
}

async function requestPricingModels(config) {
  const endpoint = `${config.domain}/api/pricing`;
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`价格接口 HTTP ${response.status} ${response.statusText}: ${body.slice(0, 1000)}`);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`价格接口未返回有效 JSON：${body.slice(0, 1000)}`);
  }
  if (payload?.error || payload?.success === false) {
    throw new Error(`价格接口返回错误：${JSON.stringify(payload?.error ?? payload)}`);
  }
  return selectLowestPricedModels(payload?.data, config.modelsCount);
}

async function resolveModels(config) {
  if (config.models) return config.models;

  const models = await requestPricingModels(config);
  console.log(
    `[${new Date().toISOString()}] MODELS 未配置，已从价格接口选择前 ${models.length} 个模型：${models.join(', ')}`,
  );
  return models;
}

async function requestChat(config, model) {
  const response = await fetch(`${config.domain}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      stream: false,
      temperature: 1,
      model,
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

async function sendSuccessEmail(config, model, modelIndex) {
  const transporter = createMailer(config);
  await transporter.sendMail({
    from: config.mailFrom,
    to: config.mailTo,
    subject: `【Cron Token】Success ✅ ${model}`,
    text: [
      `模型 ${model} 请求成功。`,
      `模型索引：${modelIndex}`,
      `此前失败的模型数：${modelIndex}`,
      `时间：${new Date().toISOString()}`,
      `接口：${config.domain}/v1/chat/completions`,
    ].join('\n'),
  });
}

async function sendFailureEmail(config, errors) {
  const transporter = createMailer(config);
  const attempted = errors.length;
  const details = errors
    .map(({ model, message }, index) => `第 ${index + 1} 次（${model}）：${message}`)
    .join('\n');

  await transporter.sendMail({
    from: config.mailFrom,
    to: config.mailTo,
    subject: '【Cron Token】Fail ❌',
    text: [
      '本次任务未成功完成：候选模型均请求失败，或动态模型列表获取失败。',
      `时间：${new Date().toISOString()}`,
      `接口：${config.domain}/v1/chat/completions`,
      `已尝试模型数：${attempted}`,
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

  try {
    let models;
    try {
      models = await resolveModels(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ model: '动态模型发现', message });
      console.error(`[${new Date().toISOString()}] 获取动态模型列表失败：${message}`);
      try {
        await sendFailureEmail(config, errors);
        console.log(`[${new Date().toISOString()}] 告警邮件已发送`);
      } catch (mailError) {
        console.error(`[${new Date().toISOString()}] 告警邮件发送失败：`, mailError);
      }
      return;
    }

    const totalModels = models.length;
    for (const [modelIndex, model] of models.entries()) {
      try {
        console.log(
          `[${new Date().toISOString()}] 开始请求模型 ${modelIndex + 1}/${totalModels}：${model}`,
        );
        const data = await requestChat(config, model);
        console.log(`[${new Date().toISOString()}] 模型 ${model} 请求成功`, JSON.stringify(data));
        try {
          await sendSuccessEmail(config, model, modelIndex);
          console.log(`[${new Date().toISOString()}] 成功邮件已发送`);
        } catch (error) {
          console.error(`[${new Date().toISOString()}] 成功邮件发送失败：`, error);
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ model, message });
        console.error(
          `[${new Date().toISOString()}] 模型 ${model} 请求失败：${message}`,
        );
        if (modelIndex < totalModels - 1) await sleep(config.retryDelayMs);
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
  const task = cron.schedule(config.schedule, () => run(config), {
    timezone: config.timezone,
    noOverlap: true,
  });
  task.on('execution:missed', ({ date }) => {
    console.warn(
      `[${new Date().toISOString()}] 检测到计划时间 ${date.toISOString()} 漏执行，立即补跑`,
    );
    return run(config);
  });
  console.log(`服务已启动；计划：${config.schedule}；时区：${config.timezone}`);
  if (config.runOnStart) {
    console.log('RUN_ON_START=true，立即执行一次任务');
    void run(config);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('服务启动失败：', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = {
  pricingSortValue,
  requestPricingModels,
  resolveModels,
  selectLowestPricedModels,
};
