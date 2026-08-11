# Scheduled Chat Health Check

Node.js 定时服务：按 Cron 计划请求 Chat Completions 接口；请求失败时进行重试，并通过 SMTP 发送执行结果邮件。

## 配置

| 环境变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DOMAIN` | 是 | - | API 域名，如 `https://api.example.com` |
| `API_KEY` | 是 | - | Bearer Token |
| `MODEL` | 否 | `Qwen3.6-35B-A3B-FP8` | Chat Completions 请求使用的模型名 |
| `CONTENT` | 否 | `你好` | 用户消息内容 |
| `RETRY_COUNT` | 否 | `3` | 首次失败后的额外重试次数；`0` 表示不重试 |
| `CRON` | 否 | `0 10 * * *` | Cron 表达式，默认每天上午 10 点 |
| `TZ` | 否 | `Asia/Shanghai` | Cron 时区 |
| `RUN_ON_START` | 否 | `false` | 设为 `true` 时，服务启动后立即执行一次 |
| `REQUEST_TIMEOUT_MS` | 否 | `30000` | 单次请求超时（毫秒） |
| `RETRY_DELAY_MS` | 否 | `5000` | 两次请求之间的等待时间（毫秒） |
| `SMTP_HOST` | 是 | - | SMTP 主机 |
| `SMTP_PORT` | 否 | `587` | SMTP 端口 |
| `SMTP_SECURE` | 否 | `false` | 端口 465 通常设为 `true` |
| `SMTP_USER` | 否 | - | SMTP 用户名；无认证中继可不填 |
| `SMTP_PASS` | 否 | - | SMTP 密码或授权码 |
| `MAIL_FROM` | 是 | - | 发件人 |
| `MAIL_TO` | 是 | - | 收件人，可用逗号分隔多个地址 |

HTTP 非 2xx、响应不是有效 JSON，或响应中包含 `error` 字段，均视为失败。

每次定时任务都会发送一封结果邮件：

- 成功标题：`【Cron Token】Success ✅`，正文包含第几次请求成功。
- 失败标题：`【Cron Token】Fail ❌`，正文包含实际重试次数及每次失败详情。
- 邮件发送失败只会写入容器日志，不会改变 API 请求结果或触发额外重试。

## Docker 部署

复制并编辑配置：

```sh
cp .env.example .env
```

构建并启动：

```sh
docker compose up -d --build
```

查看日志：

```sh
docker compose logs -f scheduled-chat
```

修改 `.env` 后，重新创建容器使配置生效：

```sh
docker compose up -d --force-recreate
```

服务默认不会在容器启动时立即请求；设置 `RUN_ON_START=true` 后会在启动时执行一次，同时保留后续 Cron 调度。相同任务尚未结束时，新一次触发会被跳过。
