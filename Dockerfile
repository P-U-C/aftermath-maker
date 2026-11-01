FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
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
ARG VCS_REF=unknown
ENV GIT_COMMIT=$VCS_REF NEXT_PUBLIC_GIT_COMMIT=$VCS_REF
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > /app/.maker-built-at \
  && BUILT_AT="$(cat /app/.maker-built-at)" NEXT_PUBLIC_BUILD_AT="$(cat /app/.maker-built-at)" npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/P-U-C/aftermath-maker" \
      org.opencontainers.image.revision="$VCS_REF"
ENV NODE_ENV=production GIT_COMMIT=$VCS_REF

WORKDIR /app

RUN groupadd --system --gid 10001 maker \
  && useradd --system --uid 10001 --gid maker --home-dir /app maker \
  && mkdir -p /data \
  && chown maker:maker /data
COPY --from=build --chown=maker:maker /app /app

USER maker
EXPOSE 8787 8788
CMD ["npm", "run", "start", "-w", "@puc/web"]
