FROM --platform=$BUILDPLATFORM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts/prepare-node-ca.cjs ./scripts/prepare-node-ca.cjs
RUN node scripts/prepare-node-ca.cjs /opt/homelab-ca
RUN pnpm run build && pnpm prune --prod

FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
ENV NODE_ENV=production \
    DATA_DIR=/data \
    CONFIG_DIR=/config \
    LOG_DIR=/logs
WORKDIR /app
RUN addgroup -S app && adduser -S -G app app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build /opt/homelab-ca /opt/homelab-ca
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
