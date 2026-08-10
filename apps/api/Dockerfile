FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --filter @kernelarchive/api... --frozen-lockfile=false

FROM deps AS runner
COPY apps/api apps/api
COPY packages/shared packages/shared
EXPOSE 4002
CMD ["pnpm", "--filter", "@kernelarchive/api", "start"]

