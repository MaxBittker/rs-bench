#!/bin/bash
# Start game services if not already running (idempotent).
# Called by verifier and optionally by agents that don't use MCP.

# Prevent agents from using generateSave to pre-level characters (cheating)
rm -f /app/sdk/test/utils/save-generator.ts /app/sdk/test/utils/save-generator.js 2>/dev/null || true

if curl -sf http://localhost:7780 > /dev/null 2>&1; then
    # Services running. Ensure skill tracker is also running.
    if ! pgrep -f skill_tracker > /dev/null 2>&1; then
        echo "[ensure-services] Starting skill tracker..."
        mkdir -p /logs/tracking
        cd /app && TRACKING_FILE=/logs/tracking/skill_tracking.json nohup bun run benchmark/shared/skill_tracker.ts > /logs/tracking/skill_tracker.log 2>&1 &
    fi
    exit 0
fi
echo "[ensure-services] Services not running, starting..."
/start-services.sh
echo "[ensure-services] Starting skill tracker..."
mkdir -p /logs/tracking
cd /app && TRACKING_FILE=/logs/tracking/skill_tracking.json nohup bun run benchmark/shared/skill_tracker.ts > /logs/tracking/skill_tracker.log 2>&1 &
echo "[ensure-services] Services ready"
