# https://developers.home-assistant.io/docs/apps/configuration#app-dockerfile
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.23

# ---- Builder ----------------------------------------------------------------
# Compiles TypeScript and installs only production dependencies. This whole
# stage — npm's registry cache, devDependencies, the TS toolchain — is
# discarded; only dist/, the pruned node_modules, and package.json below are
# copied into the runtime image.
FROM ${BUILD_FROM} AS builder
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY app/package.json app/package-lock.json* ./
RUN npm ci
COPY app/ ./
RUN npm run build \
    && npm prune --omit=dev

# ---- Runtime ------------------------------------------------------------------
FROM ${BUILD_FROM}

# Install tempio for templating config files at runtime
ARG TEMPIO_VERSION=2021.09.0
ARG TARGETARCH
RUN \
    if [ -z "${TARGETARCH}" ]; then \
        echo "TARGETARCH is not set, please use Docker BuildKit for the build." && exit 1; \
    fi \
    && case "${TARGETARCH}" in \
        amd64) tempio_arch="amd64" ;; \
        arm64|aarch64) tempio_arch="aarch64" ;; \
        *) echo "Unsupported TARGETARCH: ${TARGETARCH}" && exit 1 ;; \
    esac \
    && curl -sSLf -o /usr/bin/tempio \
        "https://github.com/home-assistant/tempio/releases/download/${TEMPIO_VERSION}/tempio_${tempio_arch}" \
    && chmod a+x /usr/bin/tempio

# Ensure the Node.js runtime is available. npm is intentionally not installed
# here — the app is started directly via `node dist/index.js` (see
# rootfs/usr/bin/my_program), so the runtime image never needs it.
RUN apk add --no-cache nodejs

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy root filesystem (s6 service, apparmor profile, etc.)
COPY rootfs /
RUN chmod a+x /usr/bin/my_program \
    && chmod a+x /etc/services.d/vrm-mqtt/run \
    && chmod a+x /etc/services.d/vrm-mqtt/finish

LABEL \
    org.opencontainers.image.title="Home Assistant App: VRM MQTT" \
    org.opencontainers.image.description="Bridges Victron VRM installations to the Home Assistant Mosquitto broker." \
    org.opencontainers.image.source="https://github.com/KaiGrassnick/vrm-mqtt-apps" \
    org.opencontainers.image.licenses="MIT"