# Scheduled Chat Health Check

Node.js 定时服务：按 Cron 计划请求 Chat Completions 接口；当前模型失败时按配置顺序切换到下一个模型，并通过 SMTP 发送执行结果邮件。

## 配置

| 环境变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DOMAIN` | 是 | - | API 域名，如 `https://api.example.com` |
| `API_KEY` | 是 | - | Bearer Token |
| `MODELS` | 否 | `Qwen3.6-35B-A3B-FP8` | 按尝试顺序排列的模型名，多个用英文逗号分隔 |
| `CONTENT` | 否 | `你好` | 用户消息内容 |
| `CRON` | 否 | `0 10 * * *` | Cron 表达式，默认每天上午 10 点 |
| `TZ` | 否 | `Asia/Shanghai` | Cron 时区 |
| `RUN_ON_START` | 否 | `false` | 设为 `true` 时，服务启动后立即执行一次 |
| `REQUEST_TIMEOUT_MS` | 否 | `30000` | 单次请求超时（毫秒） |
| `RETRY_DELAY_MS` | 否 | `5000` | 当前模型失败后，切换到下一模型前的等待时间（毫秒） |
| `SMTP_HOST` | 是 | - | SMTP 主机 |
| `SMTP_PORT` | 否 | `587` | SMTP 端口 |
| `SMTP_SECURE` | 否 | `false` | 端口 465 通常设为 `true` |
| `SMTP_USER` | 否 | - | SMTP 用户名；无认证中继可不填 |
| `SMTP_PASS` | 否 | - | SMTP 密码或授权码 |
| `MAIL_FROM` | 是 | - | 发件人 |
| `MAIL_TO` | 是 | - | 收件人，可用逗号分隔多个地址 |

HTTP 非 2xx、响应不是有效 JSON，或响应中包含 `error` 字段，均视为失败。

`MODELS=model-a,model-b,model-c` 会先请求 `model-a`；失败后请求 `model-b`，以此类推。任一模型成功后立即结束本次任务，每个模型最多请求一次。

每次定时任务都会发送一封结果邮件：

- 成功标题：`【Cron Token】Success ✅ <模型名>`，正文也会包含成功的模型及其索引。
- 失败标题：`【Cron Token】Fail ❌`，正文包含每个模型的失败详情。
- 邮件发送失败只会写入容器日志，不会改变 API 请求结果或尝试额外模型。

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

如果因宿主机休眠、虚拟机时钟跳变或事件循环长时间阻塞而错过计划时间，服务会在检测到 `execution:missed` 后立即补跑一次。
