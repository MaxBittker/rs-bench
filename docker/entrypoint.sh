#!/bin/bash
set -e

# ── Xvfb virtual display ─────────────────────────────────────────
echo "[entrypoint] Starting Xvfb virtual display..."
Xvfb :99 -screen 0 800x600x24 -ac &
XVFB_PID=$!
export DISPLAY=:99
sleep 1

echo "[entrypoint] Starting game engine..."
cd /app/server/engine && bun run src/app.ts &
ENGINE_PID=$!

# Wait for engine web server (serves bot client page)
echo "[entrypoint] Waiting for engine to be ready..."
for i in $(seq 1 120); do
    if curl -sf http://localhost:8888 > /dev/null 2>&1; then
        echo "[entrypoint] Engine ready on port 8888"
        break
    fi
    if [ $i -eq 120 ]; then
        echo "[entrypoint] ERROR: Engine failed to start within 120s"
        exit 1
    fi
    sleep 1
done

echo "[entrypoint] Starting gateway..."
cd /app/server/gateway && bun run gateway.ts &
GATEWAY_PID=$!
sleep 3
echo "[entrypoint] Gateway ready on port 7780"

echo "[entrypoint] Launching bot client (non-headless on Xvfb)..."
cd /app/server/gateway && bun run launch-bot.ts &
BOT_PID=$!

# Wait for bot to be in-game (puppeteer + tutorial skip)
echo "[entrypoint] Waiting for bot to connect and finish tutorial..."
for i in $(seq 1 120); do
    # Check if launch-bot.ts printed its ready message
    if curl -sf "http://localhost:7780" > /dev/null 2>&1; then
        break
    fi
    sleep 1
done
# Give extra time for tutorial skip
sleep 20
echo "[entrypoint] Bot should be ready"

# ── Skill tracker (runs for full container lifetime) ─────────
echo "[entrypoint] Starting skill tracker..."
mkdir -p /logs/tracking
cd /app && TRACKING_FILE=/logs/tracking/skill_tracking.json \
  nohup bun run benchmark/shared/skill_tracker.ts > /logs/tracking/skill_tracker.log 2>&1 &
echo "[entrypoint] Skill tracker started (pid=$!)"

# ── Screen recording ─────────────────────────────────────────────
RECORD_VIDEO="${RECORD_VIDEO:-1}"
FFMPEG_PID=""
mkdir -p /logs/verifier
if [ "$RECORD_VIDEO" = "1" ]; then
    echo "[entrypoint] Starting screen recording (1 fps, 400x300, h264)..."
    ffmpeg -f x11grab -framerate 1 -video_size 800x600 -i :99 \
        -vf scale=400:300 \
        -c:v libx264 -preset ultrafast -crf 38 \
        -pix_fmt yuv420p \
        -movflags +frag_keyframe+empty_moov \
        /logs/verifier/recording.mp4 \
        > /logs/verifier/ffmpeg.log 2>&1 &
    FFMPEG_PID=$!
    sleep 2
fi

echo "[entrypoint] All services running (engine=$ENGINE_PID, gateway=$GATEWAY_PID, bot=$BOT_PID)"

# ── Cleanup handler ──────────────────────────────────────────────
cleanup() {
    echo "[entrypoint] Shutting down..."
    if [ -n "$FFMPEG_PID" ]; then
        echo "[entrypoint] Stopping recording..."
        kill -INT $FFMPEG_PID 2>/dev/null
        # Give ffmpeg time to finalize the mp4
        wait $FFMPEG_PID 2>/dev/null || true
        echo "[entrypoint] Recording saved to /logs/verifier/recording.mp4"
    fi
    if [ -n "$XVFB_PID" ]; then
        kill $XVFB_PID 2>/dev/null || true
    fi
}
trap cleanup SIGTERM SIGINT EXIT

# Keep container alive. Use `wait` so bash can process SIGTERM from
# docker stop (unlike sleep, wait is interruptible by signals).
tail -f /dev/null &
TAIL_PID=$!
wait $TAIL_PID
