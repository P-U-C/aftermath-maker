FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/control/package.json apps/control/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/aftermath/package.json packages/aftermath/package.json
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 10001 maker \
  && useradd --system --uid 10001 --gid maker --home-dir /app maker \
  && mkdir -p /data \
  && chown maker:maker /data
COPY --from=build --chown=maker:maker /app /app

USER maker
EXPOSE 8787 8788
CMD ["npm", "run", "start", "-w", "@puc/web"]
