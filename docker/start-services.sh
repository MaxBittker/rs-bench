#!/bin/bash
# Starts game engine, gateway, bot client, and optionally Xvfb + screen recording.
# Designed to run before the MCP server starts.
# This is needed because Daytona does NOT run Docker ENTRYPOINT.

mkdir -p /logs/verifier
LOGFILE="/logs/verifier/services.log"
exec > >(tee -a "$LOGFILE") 2>&1

set -e

# ── Xvfb virtual display ─────────────────────────────────────────
RECORD_VIDEO="${RECORD_VIDEO:-1}"
if [ "$RECORD_VIDEO" = "1" ]; then
    echo "[services] Starting Xvfb virtual display..."
    Xvfb :99 -screen 0 800x600x24 -ac > /logs/verifier/xvfb.log 2>&1 &
    XVFB_PID=$!
    export DISPLAY=:99
    sleep 2
    if kill -0 $XVFB_PID 2>/dev/null; then
        echo "[services] Xvfb started (pid=$XVFB_PID)"
    else
        echo "[services] WARNING: Xvfb failed to start, disabling recording"
        cat /logs/verifier/xvfb.log 2>/dev/null
        RECORD_VIDEO="0"
    fi
fi

# ── Game engine ───────────────────────────────────────────────────
echo "[services] Starting game engine..."
cd /app/server/engine && bun run src/app.ts &

echo "[services] Waiting for engine to be ready..."
for i in $(seq 1 120); do
    if curl -sf http://localhost:8888 > /dev/null 2>&1; then
        echo "[services] Engine ready on port 8888"
        break
    fi
    if [ $i -eq 120 ]; then
        echo "[services] ERROR: Engine failed to start within 120s"
        exit 1
    fi
    sleep 1
done

# ── Gateway ───────────────────────────────────────────────────────
echo "[services] Starting gateway..."
cd /app/server/gateway && bun run gateway.ts &
sleep 3
echo "[services] Gateway ready on port 7780"

# ── Bot client ────────────────────────────────────────────────────
echo "[services] Launching bot client..."
cd /app/server/gateway && DISPLAY=${DISPLAY:-} bun run launch-bot.ts &

echo "[services] Waiting for bot to connect and finish tutorial..."
for i in $(seq 1 120); do
    if curl -sf "http://localhost:7780" > /dev/null 2>&1; then
        break
    fi
    sleep 1
done
sleep 20
echo "[services] Bot should be ready"

# ── Skill tracker (runs for full container lifetime) ──────────
if ! pgrep -f skill_tracker > /dev/null 2>&1; then
    echo "[services] Starting skill tracker..."
    mkdir -p /logs/tracking
    cd /app && TRACKING_FILE=/logs/tracking/skill_tracking.json \
      nohup bun run benchmark/shared/skill_tracker.ts > /logs/tracking/skill_tracker.log 2>&1 &
    echo "[services] Skill tracker started (pid=$!)"
else
    echo "[services] Skill tracker already running"
fi

# ── Screen recording ─────────────────────────────────────────────
if [ "$RECORD_VIDEO" = "1" ]; then
    echo "[services] Starting screen recording (1 fps, 400x300, h264)..."
    ffmpeg -f x11grab -framerate 1 -video_size 800x600 -i :99 \
        -vf scale=400:300 \
        -c:v libx264 -preset ultrafast -crf 38 \
        -pix_fmt yuv420p \
        -movflags +frag_keyframe+empty_moov \
        /logs/verifier/recording.mp4 \
        > /logs/verifier/ffmpeg.log 2>&1 &
    FFMPEG_PID=$!
    sleep 2
    if kill -0 $FFMPEG_PID 2>/dev/null; then
        echo "[services] Recording started (pid=$FFMPEG_PID)"
    else
        echo "[services] WARNING: ffmpeg failed to start"
        cat /logs/verifier/ffmpeg.log 2>/dev/null
    fi
fi

echo "[services] All services running"
