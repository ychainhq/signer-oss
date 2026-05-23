FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine AS runner
# Run as non-root
RUN addgroup -S signer && adduser -S signer -G signer
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
RUN mkdir -p /app/data && chown -R signer:signer /app/data
USER signer
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost:${SIGNER_PORT:-3101}/health || exit 1
ENTRYPOINT ["node", "dist/main.js"]
