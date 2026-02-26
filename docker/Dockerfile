FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies:
#   chromium     - real chromium binary (not a snap shim like ubuntu 24.04)
#   default-jre  - Java runtime for RuneScript compiler (engine cache packing)
RUN apt-get update && apt-get install -y \
    curl \
    git \
    chromium \
    default-jre-headless \
    unzip \
    ca-certificates \
    procps \
    xvfb \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Use system chromium instead of puppeteer downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 8x faster game simulation (50ms ticks vs default 420ms)
ENV NODE_TICKRATE=50

# Clone rs-sdk
ARG RS_SDK_REPO=https://github.com/MaxBittker/rs-sdk.git
ARG RS_SDK_REF=main
RUN git clone --depth 1 --branch $RS_SDK_REF $RS_SDK_REPO /app
WORKDIR /app

# Install all workspace dependencies
RUN bun install
RUN cd server/engine && bun install
RUN cd server/gateway && bun install
RUN cd server/webclient && bun install && bun run build
RUN cp -r server/webclient/out/bot server/engine/public/bot
RUN cd mcp && bun install

# Remove scripts/ directory — benchmark agents waste budget reading/running these
RUN rm -rf /app/scripts

# Pre-pack game cache and let engine fully start so all data files are generated.
# Wait for "World ready" in output, then kill. This ensures maps, scripts, configs are all packed.
RUN cd server/engine && \
    bun run src/app.ts > /tmp/engine.log 2>&1 & \
    for i in $(seq 1 300); do \
        grep -q "World ready" /tmp/engine.log 2>/dev/null && break; \
        sleep 1; \
    done && \
    sleep 2 && kill $(jobs -p) 2>/dev/null; rm -f /tmp/engine.log; true

# Create bot credentials (local server, no remote)
RUN mkdir -p bots/agent
COPY bot.env bots/agent/bot.env

# Pre-install Claude Code CLI (Harbor's agent setup tries to curl this and
# fails inside Daytona sandboxes due to connection resets).
# Symlink to /usr/local/bin so it's on PATH for any user (Daytona may not run as root).
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -s /root/.local/share/claude/versions/* /usr/local/bin/claude

# Copy entrypoint and helper scripts
COPY entrypoint.sh /entrypoint.sh
COPY start-services.sh /start-services.sh
COPY launch-bot.ts /app/server/gateway/launch-bot.ts
RUN chmod +x /entrypoint.sh /start-services.sh

# SAMPLE_INTERVAL_MS can be overridden per task via ENV in the thin FROM layer.
COPY skill_tracker.ts /app/benchmark/shared/skill_tracker.ts

# Ensure bot.env has SERVER=localhost so scripts connect to the local gateway
RUN echo 'SERVER=localhost' >> /app/bots/agent/bot.env

# Wrapper: start services, launch tracker in background (fully detached), then run MCP server.
# Tracker writes to /logs/tracking/ (outside /app/ so agents don't see benchmark infra files).
RUN printf '#!/bin/bash\n/start-services.sh\nmkdir -p /logs/verifier /logs/tracking\ncd /app\nexport TRACKING_FILE=/logs/tracking/skill_tracking.json\nnohup bun run benchmark/shared/skill_tracker.ts > /logs/tracking/skill_tracker.log 2>&1 &\nexec bun run mcp/server.ts\n' > /start-with-tracker.sh && chmod +x /start-with-tracker.sh

# Override .mcp.json so Claude Code starts game services before the MCP server.
# Services start in background (&) so the MCP server is immediately responsive.
RUN echo '{"mcpServers":{"rs-agent":{"command":"bash","args":["-c","/start-services.sh & cd /app && bun run mcp/server.ts"]}}}' > /app/.mcp.json

# Idempotent service starter for agents that don't use MCP (e.g. gemini-cli)
COPY ensure-services.sh /ensure-services.sh
RUN chmod +x /ensure-services.sh

ENTRYPOINT ["/entrypoint.sh"]
