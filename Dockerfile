# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
COPY --from=frontend /src/internal/web/ui/dist ./internal/web/ui/dist
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
    -ldflags="-s -w -X main.version=$VERSION" -o /out/pikpak-rss-manager ./cmd/pikpak-rss-manager
RUN mkdir -p /rootfs/data /rootfs/tmp && chown 65532:65532 /rootfs/data && chmod 1777 /rootfs/tmp

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/wade00754/pikpak-rss-manager" \
      org.opencontainers.image.description="Lightweight PikPak RSS automation with official PAT and MCP" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chown=65532:65532 /rootfs/data /data
COPY --from=build /rootfs/tmp /tmp
COPY --from=build /out/pikpak-rss-manager /app/pikpak-rss-manager
ENV APP_LISTEN=0.0.0.0:8080 APP_DATA_DIR=/data
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/app/pikpak-rss-manager", "healthcheck"]
ENTRYPOINT ["/app/pikpak-rss-manager"]
