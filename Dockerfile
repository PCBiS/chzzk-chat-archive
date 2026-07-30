FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    CONFIG_DIR=/config \
    LOG_DIR=/logs
WORKDIR /app
RUN addgroup -S app && adduser -S -G app app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
COPY --chown=app:app public ./public
COPY --chown=app:app config /config
RUN cp /config/credentials.example.json /config/credentials.json \
    && mkdir -p /data /logs \
    && chown app:app /data /logs /config /config/credentials.json
USER app
EXPOSE 3000
VOLUME ["/data", "/config", "/logs"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.js"]
