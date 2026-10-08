# conf-kit: PocketBase с хуками, миграциями и собранным фронтендом. Сборка из корня репозитория:
#   docker compose -f deploy/docker-compose.yml build
# Раскладка в /app повторяет репозиторий (pb/pb_hooks, shared, dist): хуки находят shared/ и dist/app.css
# по путям относительно себя, как и при запуске из исходников.

FROM node:22-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web web
COPY shared shared
COPY public public
RUN node web/build.mjs

FROM alpine:3.20
ARG PB_VERSION=0.40.4
# sha256 из checksums.txt релиза PocketBase; при смене версии — обновить обе
ARG PB_SHA256_AMD64=9042ec818570e79c3628dadcd0a756c1496d9e1173918ec409d133c02f82e5fa
ARG PB_SHA256_ARM64=86095bf8ed9345954f0d2bf0a5fb9b57584ae60b77ebf3b6cd23a8003a3fd418
ARG TARGETARCH=amd64
RUN apk add --no-cache ca-certificates tzdata \
 && apk add --no-cache --virtual .fetch unzip wget \
 && wget -q -O /tmp/pb.zip "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip" \
 && if [ "$TARGETARCH" = "arm64" ]; then SUM="$PB_SHA256_ARM64"; else SUM="$PB_SHA256_AMD64"; fi \
 && echo "$SUM  /tmp/pb.zip" | sha256sum -c - \
 && unzip -q /tmp/pb.zip pocketbase -d /usr/local/bin \
 && rm /tmp/pb.zip && apk del .fetch \
 && adduser -D -H -u 10001 conf

WORKDIR /app
COPY pb/pb_hooks pb/pb_hooks
COPY pb/pb_migrations pb/pb_migrations
COPY shared shared
COPY --from=web /src/dist dist
COPY deploy/pb.sh /usr/local/bin/pb
RUN chmod 755 /usr/local/bin/pb && mkdir -p /app/pb/pb_data && chown conf /app/pb/pb_data

USER conf
VOLUME /app/pb/pb_data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8090/api/health || exit 1
# без automigrate: коллекции меняются только миграциями из репозитория
CMD ["pb", "serve", "--http=0.0.0.0:8090", "--automigrate=false"]
