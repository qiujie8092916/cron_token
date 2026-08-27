# cron_qoder

一个常驻的 Node.js 20 / TypeScript 调度器：按五段 Cron 表达式调用 Qoder Agent SDK，按 `MODELS` 顺序逐个回退，并将最终文本输出到终端。

## 特性

- 每次 Cron 触发创建独立会话，不保存会话历史。
- 任务按无限长度 FIFO 队列严格串行执行。
- 每个模型仅尝试一次，失败后等待指定时间再尝试下一个模型。
- 整个任务共享一个总超时，包括模型调用和回退等待。
- Qoder配置为 `tools: []`，无法读取/修改文件、执行命令或调用其他工具。
- `SIGINT`/`SIGTERM` 会停止调度、丢弃排队任务，并通过 SDK中断当前请求。

## 安装

需要 Node.js 20或更高版本，以及 pnpm。

```bash
pnpm install
cp .env.example .env
```

在 [Qoder Account → Integrations](https://qoder.com/account/integrations) 创建PAT，复制后立即妥善保存，并写入本地 `.env`。`.env`已加入 `.gitignore`。

## 配置

```dotenv
# 必填
ACCESS_TOKEN=your-qoder-pat
CONTENT="请用一句话回答当前状态。"
MODELS=lite,efficient,auto
CRON=*/5 * * * *

# 可选
TZ=Asia/Shanghai
RUN_ON_START=false
REQUEST_TIMEOUT_MS=30000
RETRY_DELAY_MS=5000
```

### 变量说明

- `ACCESS_TOKEN`：Qoder PAT。程序通过 `accessTokenFromEnv("ACCESS_TOKEN")`读取，不会主动打印。
- `CONTENT`：每次任务发送的固定文本。双引号字符串可用 `\n`表示换行。
- `MODELS`：英文逗号分隔的有序回退列表。程序会去除空格、空项和重复项，并保留首次出现顺序。
- `CRON`：标准五段表达式，即“分 时 日 月 周”。不支持秒字段。
- `TZ`：有效的 IANA 时区，默认 `Asia/Shanghai`。
- `RUN_ON_START`：只能是 `true`或 `false`，默认 `false`。
- `REQUEST_TIMEOUT_MS`：整个任务的总超时，必须为正整数，默认 `30000`。
- `RETRY_DELAY_MS`：模型回退前的等待毫秒数，必须为非负整数，默认 `5000`。

内置模型档位为：

- `lite`
- `efficient`
- `auto`
- `performance`
- `ultimate`

也可以填写账户支持的具体模型ID。程序不会在启动时联网验证模型ID；任务执行时若模型失败，会继续尝试列表中的下一个模型。

任何必填变量缺失、Cron/时区无效或可选变量格式错误，程序都会在启动时以非零状态退出。

## 运行

### Docker Compose

确认 `.env`已经配置后，构建并在后台启动：

```bash
docker compose up --build -d
```

持续查看终端输出：

```bash
docker compose logs -f scheduled-qoder
```

停止并移除容器：

```bash
docker compose down
```

Compose服务配置了 `restart: unless-stopped`。`.env`只在容器启动时通过 `env_file`注入，并已加入 `.dockerignore`，不会被复制进镜像。

### 本机运行

开发模式：

```bash
pnpm dev
```

生产构建与运行：

```bash
pnpm build
pnpm start
```

终端会显示时间、任务序号、队列深度、模型尝试、失败与回退、耗时和最终回答。停机期间错过的 Cron 触发不会补执行。

## 停止

按 `Ctrl+C`或向进程发送 `SIGTERM`。程序会停止接受任务、丢弃排队任务、中断当前 Qoder调用，并等待 SDK清理完成后退出。
