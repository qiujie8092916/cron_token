FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/scheduler-token/package.json apps/scheduler-token/package.json
COPY apps/scheduler-qoder/package.json apps/scheduler-qoder/package.json
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/scheduler-token apps/scheduler-token
COPY apps/scheduler-qoder apps/scheduler-qoder
RUN pnpm run build && pnpm install --prod --frozen-lockfile --offline

FROM node:22-bookworm-slim AS runtime-base
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node

FROM runtime-base AS scheduler-token
CMD ["node", "apps/scheduler-token/dist/index.js"]

FROM runtime-base AS scheduler-qoder
CMD ["node", "apps/scheduler-qoder/dist/index.js"]
