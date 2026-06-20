# Build context: repo root (chain-api/)
# docker-compose.v3.yml: context: ..  dockerfile: signer-oss/Dockerfile
#
# Local packages (@chain-api/external-signer-*) are resolved from packages/
# via file: references in package.json — no npm registry needed.

FROM node:20-alpine AS builder
WORKDIR /app

# 1. Build external-signer-protocol first (no local deps)
COPY packages/external-signer-protocol/ ./packages/external-signer-protocol/
RUN cd packages/external-signer-protocol && npm install --ignore-scripts && npm run build

# 2. Build external-signer-core (depends on protocol via file:../external-signer-protocol)
COPY packages/external-signer-core/ ./packages/external-signer-core/
RUN cd packages/external-signer-core && npm install --ignore-scripts && npm run build

# 3. Copy signer-oss and install (file: refs resolve correctly from signer-oss/)
WORKDIR /app/signer-oss
COPY signer-oss/package*.json ./
RUN npm install --ignore-scripts

# npm creates symlinks for file: deps — replace with real copies so they survive
# the COPY to the runner stage (Docker COPY does NOT dereference symlinked dirs)
RUN cp -rL node_modules/@chain-api/external-signer-core     /tmp/_esc && \
    rm -rf  node_modules/@chain-api/external-signer-core           && \
    mv      /tmp/_esc node_modules/@chain-api/external-signer-core && \
    cp -rL  node_modules/@chain-api/external-signer-protocol /tmp/_esp && \
    rm -rf  node_modules/@chain-api/external-signer-protocol       && \
    mv      /tmp/_esp node_modules/@chain-api/external-signer-protocol

COPY signer-oss/tsconfig.json ./
COPY signer-oss/src/ ./src/
RUN npm run build

# ── Runtime image ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN addgroup -S signer && adduser -S signer -G signer
WORKDIR /app

COPY --from=builder /app/signer-oss/dist         ./dist
COPY --from=builder /app/signer-oss/node_modules ./node_modules

RUN mkdir -p /app/data && chown -R signer:signer /app/data
USER signer

EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:${SIGNER_PORT:-3101}/health || exit 1

ENTRYPOINT ["node", "dist/main.js"]
