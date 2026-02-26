#!/bin/bash
# Run total-level benchmark across models on Daytona.
#
# Usage:
#   benchmark/run-total-level.sh                    # all models, 8m test
#   benchmark/run-total-level.sh --duration 1h      # 1-hour production run
#   benchmark/run-total-level.sh -m opus            # single model
#   benchmark/run-total-level.sh -m codex           # codex only
#   benchmark/run-total-level.sh -m gemini          # gemini only
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Model definitions (agent|model-id|label) ────────────────────
# Same pipe-delimited format as other run scripts for bash 3 compat
ALL_MODELS="
claude-code|anthropic/claude-opus-4-6|opus
claude-code|anthropic/claude-sonnet-4-6|sonnet46
claude-code|anthropic/claude-sonnet-4-5|sonnet45
claude-code|anthropic/claude-haiku-4-5|haiku
codex|openai/gpt-5.3-codex|codex
gemini-cli|google/gemini-3-pro-preview|gemini
claude-code|glm-5|glm
kimi-opencode|openrouter/moonshotai/kimi-k2.5|kimi
qwen3-opencode|openrouter/qwen/qwen3-coder-next|qwen3

"

# ── Lookup helper (bash 3 compatible) ────────────────────────────
lookup_model() {
  local name="$1"
  echo "$ALL_MODELS" | while IFS='|' read -r agent model label; do
    if [ "$label" = "$name" ]; then
      echo "$agent|$model|$label"
      return 0
    fi
  done
}

# ── Load API keys from .env ───────────────────────────────────────
if [ -f "$SCRIPT_DIR/../.env" ]; then
    set -a
    source "$SCRIPT_DIR/../.env"
    set +a
fi
GLM_KEY="${GLM_API_KEY:-}"

# Verify required keys
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "ERROR: ANTHROPIC_API_KEY not set (check .env)"
    exit 1
fi
if [ -z "$DAYTONA_API_KEY" ]; then
    echo "ERROR: DAYTONA_API_KEY not set (check .env)"
    exit 1
fi

# ── Defaults ──────────────────────────────────────────────────────
DURATION="8m"
TASK="total-level-8m"
SELECTED_MODELS=""
CONCURRENCY=1
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --duration|-d)
            DURATION="$2"
            shift 2
            ;;
        -m|--model)
            SELECTED_MODELS="$SELECTED_MODELS $2"
            shift 2
            ;;
        -n|--concurrency)
            CONCURRENCY="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: benchmark/run-total-level.sh [options]"
            echo ""
            echo "Options:"
            echo "  --duration, -d   5m, 8m (default), 10m, 30m, 1h, 3h"
            echo "  --model, -m      opus, sonnet46, sonnet45, haiku, codex, gemini, glm, kimi, qwen3 (default: all)"
            echo "  --concurrency    Number of concurrent trials (default: 1)"
            exit 0
            ;;
        *)
            EXTRA_ARGS="$EXTRA_ARGS $1"
            shift
            ;;
    esac
done

# Map duration to task
case "$DURATION" in
    5m|5min)
        TASK="total-level-5m"
        ;;
    8m|8min|test)
        TASK="total-level-8m"
        ;;
    10m|10min)
        TASK="total-level-10m"
        ;;
    30m|30min)
        TASK="total-level-30m"
        ;;
    1h|60m|hour|prod)
        TASK="total-level-1h"
        ;;
    3h|180m)
        TASK="total-level-3h"
        ;;
    *)
        echo "Unknown duration: $DURATION (use 5m, 8m, 10m, 30m, 1h, or 3h)"
        exit 1
        ;;
esac

# Default to all models if none specified
if [ -z "$SELECTED_MODELS" ]; then
    SELECTED_MODELS="opus sonnet46 sonnet45 haiku codex gemini glm kimi qwen3"
fi

# ── Regenerate tasks ──────────────────────────────────────────────
echo "Regenerating benchmark tasks..."
bun "$SCRIPT_DIR/generate-tasks.ts"
echo ""

# ── Run each model ────────────────────────────────────────────────
JOB_PREFIX="total-level-$(date +%Y%m%d-%H%M%S)"

for name in $SELECTED_MODELS; do
    entry=$(lookup_model "$name")
    if [ -z "$entry" ]; then
        echo "Unknown model: $name (available: opus, sonnet46, sonnet45, haiku, codex, gemini, glm, kimi, qwen3)"
        exit 1
    fi

    IFS='|' read -r agent model label <<< "$entry"

    # GLM needs custom env
    ENV_PREFIX=""
    AGENT_FLAG="-a '$agent'"
    if [ "$name" = "glm" ]; then
        if [ -z "$GLM_KEY" ]; then
            echo "  WARNING: GLM_API_KEY not found in .env, skipping glm"
            continue
        fi
        ENV_PREFIX="ANTHROPIC_API_KEY=$GLM_KEY ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic API_TIMEOUT_MS=3000000"
    elif [ "$name" = "kimi" ]; then
        if [ -z "$OPENROUTER_API_KEY" ]; then
            echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping kimi"
            continue
        fi
        ENV_PREFIX="PYTHONPATH=$SCRIPT_DIR:\${PYTHONPATH:-}"
        AGENT_FLAG="--agent-import-path 'kimi_adapter:KimiOpenCode'"
    elif [ "$name" = "qwen3" ]; then
        if [ -z "$OPENROUTER_API_KEY" ]; then
            echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping qwen3"
            continue
        fi
        ENV_PREFIX="PYTHONPATH=$SCRIPT_DIR:\${PYTHONPATH:-}"
        AGENT_FLAG="--agent-import-path 'qwen3_adapter:Qwen3OpenCode'"
    fi

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Running: $name ($model)"
    echo "  Task:    $TASK"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    eval "$ENV_PREFIX harbor run \
        -p '$SCRIPT_DIR/tasks/$TASK' \
        $AGENT_FLAG \
        -m '$model' \
        --env daytona \
        -n '$CONCURRENCY' \
        --job-name '${JOB_PREFIX}-${label}' \
        $EXTRA_ARGS"

    echo ""
done

echo "All runs complete!"
echo ""
echo "To extract results: bun benchmark/extract-results.ts --filter ${JOB_PREFIX}"
