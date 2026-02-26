#!/bin/bash
# Run the benchmark suite across models on Daytona.
#
# Usage:
#   benchmark/run.sh                    # all models, woodcutting-xp-10m
#   benchmark/run.sh -t woodcutting-xp-5m
#   benchmark/run.sh -m sonnet45        # single model
#   benchmark/run.sh -n 2               # 2 trials per model
#   benchmark/run.sh -c 4               # 4 concurrent trials
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Model definitions (agent|model-id|label) ────────────────────
# Same pipe-delimited format as run-comparison.sh for bash 3 compat
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

# ── Defaults ──────────────────────────────────────────────────────
TASK="woodcutting-xp-10m"
SELECTED_MODELS=""
N_TRIALS=1
CONCURRENCY=2
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--task)    TASK="$2"; shift 2 ;;
    -m|--model)   SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -n|--trials)  N_TRIALS="$2"; shift 2 ;;
    -c|--concurrency) CONCURRENCY="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: benchmark/run.sh [-t task] [-m model] [-n trials] [-c concurrency]"
      echo ""
      echo "Models: opus, sonnet46, sonnet45, haiku, codex, gemini, glm, kimi, qwen3 (default: all)"
      echo "Task:   any task dir name (default: woodcutting-xp-10m)"
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

# Default to all models if none specified
if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="sonnet46 sonnet45 opus haiku codex gemini glm kimi qwen3"
fi

# Export API keys from .env so Harbor's agent classes can snapshot them.
# Without this, keys are only loaded by Python dotenv at import time,
# and import ordering can cause the snapshot to miss them.
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a  # auto-export all variables
  source "$SCRIPT_DIR/../.env"
  set +a
fi
GLM_KEY="${GLM_API_KEY:-}"

# ── Regenerate tasks ──────────────────────────────────────────────
echo "Regenerating benchmark tasks..."
bun "$SCRIPT_DIR/generate-tasks.ts"
echo ""

# ── Launch all models in parallel ─────────────────────────────────
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PIDS=""

for name in $SELECTED_MODELS; do
  entry=$(lookup_model "$name")
  if [ -z "$entry" ]; then
    echo "Unknown model: $name (available: opus, sonnet46, sonnet45, haiku, codex, gemini, glm, kimi, qwen3)"
    exit 1
  fi

  IFS='|' read -r agent model label <<< "$entry"

  # GLM needs custom env: use GLM_API_KEY and route through Z.AI proxy.
  # Override ANTHROPIC_API_KEY to prevent sending real Anthropic key.
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

  JOB_NAME="${TASK}-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Launching: $name ($model)"
  echo "  Task:      $TASK"
  echo "  Trials:    $N_TRIALS"
  echo "  Log:       $LOG_FILE"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  eval "$ENV_PREFIX harbor run \
    -p '$SCRIPT_DIR/tasks/$TASK' \
    $AGENT_FLAG \
    -m '$model' \
    --job-name '$JOB_NAME' \
    --env modal \
    -n '$CONCURRENCY' \
    -k '$N_TRIALS' \
    $EXTRA_ARGS" > "$LOG_FILE" 2>&1 &

  PIDS="$PIDS $!"
  echo ""
done

echo "All models launched. Waiting for completion..."
echo "  PIDs: $PIDS"
echo ""

FAILED=0
for pid in $PIDS; do
  if ! wait "$pid"; then
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILED" -eq 0 ]; then
  echo "All runs complete."
else
  echo "All runs finished. $FAILED model(s) had errors."
fi

# Print summary from log files
for name in $SELECTED_MODELS; do
  entry=$(lookup_model "$name")
  IFS='|' read -r agent model label <<< "$entry"
  LOG_FILE="/tmp/harbor-${TASK}-${label}-${TIMESTAMP}.log"
  if [ -f "$LOG_FILE" ]; then
    echo ""
    echo "── $name ──"
    tail -20 "$LOG_FILE"
  fi
done
