# Scheduler Token / Qoder

一个基于 Node.js 22、TypeScript 和 pnpm workspace 的定时任务仓库。两个服务由同一个 Docker Compose 管理，但分别运行在独立容器中：

- `scheduler-token`：调用兼容 Chat Completions 的 HTTP API，支持按配置模型回退或动态选择低价模型。
- `scheduler-qoder`：调用 Qoder Agent SDK，按配置模型顺序回退。

两个服务共用环境变量校验、Cron 调度、日志、邮件/钉钉通知、重试延时和时区格式化逻辑。

## 目录

```text
apps/
  scheduler-token/
  scheduler-qoder/
packages/
  shared/
env/
  common.env.example
  cron-token.env.example
  cron-qoder.env.example
compose.yaml
Dockerfile
```

## 配置

实际配置文件不会提交到 Git：

- `env/common.env`：两个服务共用的时区和通知渠道配置。
- `env/cron-token.env`：Token 服务配置。
- `env/cron-qoder.env`：Qoder 服务配置。

### 公共变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `TZ` | 否 | `Asia/Shanghai` | Cron 和通知时间使用的 IANA 时区 |
| `NOTIFY_CHANNELS` | 否 | `email` | 通知渠道：`email`、`dingtalk` 或 `email,dingtalk` |
| `SMTP_HOST` | 条件必填 | - | 使用 `email` 时的 SMTP 主机 |
| `SMTP_PORT` | 否 | `587` | SMTP 端口 |
| `SMTP_SECURE` | 否 | `false` | 使用 465 端口时通常设为 `true` |
| `SMTP_USER` | 否 | - | SMTP 用户名，无认证中继可不填 |
| `SMTP_PASS` | 条件必填 | - | 配置 `SMTP_USER` 时必须填写 |
| `MAIL_FROM` | 条件必填 | - | 使用 `email` 时的发件人 |
| `MAIL_TO` | 条件必填 | - | 使用 `email` 时的收件人，多个地址用逗号分隔 |
| `DINGTALK_WEBHOOK_URL` | 条件必填 | - | 使用 `dingtalk` 时的自定义机器人 HTTPS Webhook |
| `DINGTALK_SECRET` | 否 | - | 钉钉机器人加签密钥，推荐配置 |
| `DINGTALK_AT_ALL_ON_FAILURE` | 否 | `true` | 失败通知是否 `@所有人`；成功和跳过通知不会 @ |

### 两个服务通用的任务变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CONTENT` | 是 | - | 每次任务使用的用户 prompt |
| `CRON` | 是 | - | 标准五段 Cron 表达式 |
| `MODELS` | 见下文 | - | 英文逗号分隔的有序模型列表；重复模型会重复尝试 |
| `RUN_ON_START` | 否 | `false` | 启动时立即执行一次 |
| `ATTEMPT_TIMEOUT_MS` | 否 | `30000` | 单个模型尝试的超时；每个模型独立计时 |
| `RETRY_DELAY_MS` | 否 | `5000` | 切换到下一模型前的等待毫秒数，允许为 `0` |

任务重叠时，新触发会被跳过并发送 `Skipped` 通知，不会排队。检测到 Cron 漏执行时会立即补跑；如果此时仍有任务运行，补跑也会按重叠规则跳过。

### Token 服务

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DOMAIN` | 是 | - | HTTP API 域名 |
| `API_KEY` | 是 | - | Bearer Token |
| `MODELS` | 否 | 动态获取 | 按顺序尝试的模型；留空时每次任务请求 `{DOMAIN}/api/pricing` |
| `MODELS_COUNT` | 否 | `5` | 动态获取时选取的低价模型数量 |

动态排序规则保持原项目行为：`quota_type === 0` 使用 `model_ratio`，其他类型使用 `model_price || 0`，升序后取前 `MODELS_COUNT` 个模型。模型发现请求同样使用 `ATTEMPT_TIMEOUT_MS`。

Token 成功响应优先读取 `choices[0].message.content` 作为 assistant 内容；响应结构不符合预期时使用完整 JSON。

### Qoder 服务

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ACCESS_TOKEN` | 是 | - | Qoder PAT |
| `MODELS` | 否 | `lite,efficient,auto,performance,ultimate` | 有序模型列表；留空时使用默认五档 |

每次尝试创建不持久化的独立 Qoder 会话，并禁用 skills 和 tools。单模型超时后会中断当前 SDK 查询，再尝试下一个模型。

## 通知

`NOTIFY_CHANNELS` 支持单渠道或并行发送：

```dotenv
NOTIFY_CHANNELS=dingtalk
NOTIFY_CHANNELS=email,dingtalk
```

并行发送时会独立调用所有渠道，一个渠道失败不会阻止另一个渠道发送；任一渠道失败都会记录错误日志，但不会改变 API/Qoder 执行结果。

### 钉钉

在钉钉群中添加自定义机器人，复制 Webhook，并推荐启用“加签”安全设置：

```dotenv
NOTIFY_CHANNELS=dingtalk
DINGTALK_WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=...
DINGTALK_SECRET=SEC...
DINGTALK_AT_ALL_ON_FAILURE=true
```

钉钉使用 Markdown 消息，成功通知包含服务、触发方式、模型、尝试信息、时间、耗时、user 和 assistant；失败通知包含每个模型的错误详情，并默认 `@所有人`；跳过通知不会 @。钉钉请求固定使用 10 秒超时，并同时校验 HTTP 状态和响应中的 `errcode`。

### 邮件

邮件使用 HTML 格式，标题为：

```text
【Scheduler Token】Success ✅ <模型名>
【Scheduler Qoder】Success ✅ <模型名>
【Scheduler Token】Failed ❌
【Scheduler Qoder】Failed ❌
【Scheduler Token】Skipped ⏭️
【Scheduler Qoder】Skipped ⏭️
```

成功邮件包含服务、触发方式、模型列表、成功模型、尝试次数、前序失败详情、起止时间、耗时、user 和 assistant。user 与 assistant 各保留前 100 个字符，超长时追加省略号。失败邮件不包含 user 和 assistant，每个模型的错误保留前 500 个字符，超长时追加省略号。时间跟随 `TZ`。

邮件发送失败只记录日志，不改变 API/Qoder 执行结果。

## Docker Compose

首次使用时确认三个实际 env 文件已填写，然后执行：

```sh
docker compose up -d --build
```

查看日志：

```sh
docker compose logs -f scheduler-token scheduler-qoder
```

单独管理一个服务：

```sh
docker compose up -d --build scheduler-token
docker compose restart scheduler-qoder
```

## 本地开发

需要 Node.js 22 和 pnpm 9.15.9：

```sh
corepack enable
pnpm install
pnpm check
pnpm test
pnpm dev:token
pnpm dev:qoder
```

## 停机

收到 `SIGINT` 或 `SIGTERM` 后，服务会停止接受新任务。Token 服务会取消当前 HTTP 请求；Qoder 服务会中断当前 SDK 查询，然后等待执行结束。

旧的 `cron_qoder/.env` 按迁移约定保留，但新 Compose 不再读取它。
