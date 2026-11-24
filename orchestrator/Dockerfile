# Lily orchestrator — browser meeting adapter.
#
# The adapter needs Xvfb, PulseAudio and a real Google Chrome, none of which
# exist on Windows or macOS. This image is how the whole thing runs on a
# developer machine, and it is the same artefact that runs in production, so
# "works locally" and "works on the box" stop being different claims.
#
# Two things make this work in a container that surprise people:
#
#   * PulseAudio needs NO sound hardware here. Every device this uses is a null
#     sink, which is a pure software construct — so a container with no audio
#     device at all is fine.
#   * Xvfb means there is no display requirement either. Chrome runs headful
#     (headless is detected by Meet and Zoom) into a virtual framebuffer.
#
# The one genuine casualty is v4l2loopback, which needs a kernel module the
# Docker Desktop / WSL2 kernel does not carry. The adapter already falls back to
# a synthesised y4m card for the avatar, so this degrades rather than breaks.

# --- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests first so a source-only edit does not re-run the install layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY orchestrator/package.json ./orchestrator/
COPY api/package.json ./api/
COPY daemon/package.json ./daemon/
COPY emails/package.json ./emails/

# --ignore-scripts: playwright-core's postinstall is unnecessary because Chrome
# comes from apt below, not from a downloaded browser bundle.
RUN npm ci --ignore-scripts --workspaces --include-workspace-root

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared ./packages/shared
COPY orchestrator ./orchestrator

RUN npx tsc -b orchestrator

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    LILY_STAGE=local \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      xvfb \
      pulseaudio pulseaudio-utils \
      ffmpeg \
      # Chrome refuses to start without these, and renders boxes for any
      # non-Latin participant name without the font packages.
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
      libgtk-3-0 libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 \
      libxkbcommon0 libxrandr2 \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# Chrome refuses to run as root, and running a browser that visits arbitrary
# meeting URLs as root would be wrong regardless of whether it refused.
RUN useradd --create-home --shell /bin/bash lily \
 && mkdir -p /run/user/1000 /app \
 && chown -R lily:lily /run/user/1000 /app

WORKDIR /app
COPY --from=build --chown=lily:lily /app/node_modules ./node_modules
COPY --from=build --chown=lily:lily /app/packages/shared ./packages/shared
COPY --from=build --chown=lily:lily /app/orchestrator ./orchestrator
COPY --chown=lily:lily orchestrator/docker-entrypoint.sh /usr/local/bin/lily-entrypoint

RUN chmod +x /usr/local/bin/lily-entrypoint

USER lily
ENV XDG_RUNTIME_DIR=/run/user/1000 \
    HOME=/home/lily

# 4100 simulated room / board · 4101 daemon link
EXPOSE 4100 4101

ENTRYPOINT ["/usr/local/bin/lily-entrypoint"]
CMD ["node", "orchestrator/dist/main.js"]
