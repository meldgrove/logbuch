# One image for every Logbuch process. The command selects the role:
#   web      Next.js server (port 3000)
#   worker   pg-boss worker: notifications, webhook, Keycloak directory sync
#   migrate  applies database migrations, then exits

FROM node:26.13.0-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runtime
LABEL org.opencontainers.image.title="Meldgrove Logbuch" \
      org.opencontainers.image.description="A self-hosted log of an organization's decisions, updates, and learnings, with a consent-based decision process." \
      org.opencontainers.image.source="https://github.com/meldgrove/logbuch" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MIGRATIONS_DIR=/app/drizzle
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# The release workflow sets the version; images built from source have none.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["web"]
