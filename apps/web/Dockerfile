FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --filter @kernelarchive/web... --frozen-lockfile=false

FROM deps AS builder
COPY apps/web apps/web
COPY packages/shared packages/shared
COPY packages/ui packages/ui
RUN pnpm --filter @kernelarchive/web build

FROM base AS runner
COPY --from=builder /app/apps/web/.next apps/web/.next
COPY --from=builder /app/apps/web/package.json apps/web/package.json
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/web/node_modules apps/web/node_modules
EXPOSE 3000
CMD ["pnpm", "--filter", "@kernelarchive/web", "start"]

