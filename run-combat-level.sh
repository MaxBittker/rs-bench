#!/bin/bash
# Run combat-level-30m benchmark across models.
#
# Each model gets 30 minutes to write and iterate on combat training scripts.
# Each script run uses a fresh account. Score = best combat level from any single run.
#
# Usage:
#   benchmark/run-combat-level.sh                  # all models
#   benchmark/run-combat-level.sh -m opus           # single model
#   benchmark/run-combat-level.sh -m opus -k 3      # 3 trials per model
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Model definitions (agent|model-id|label) ────────────────────
ALL_MODELS="
claude-code|anthropic/claude-opus-4-6|opus
claude-code|anthropic/claude-sonnet-4-6|sonnet46
claude-code|anthropic/claude-sonnet-4-5|sonnet45
claude-code|anthropic/claude-haiku-4-5|haiku
codex|openai/gpt-5.3-codex|codex
gemini-cli|google/gemini-3-pro-preview|gemini
claude-code|glm-5|glm
kimi-opencode|openrouter/moonshotai/kimi-k2.5|kimi
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
SELECTED_MODELS=""
TRIALS=1
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)   SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -k|--trials)  TRIALS="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: benchmark/run-combat-level.sh [-m model] [-k trials]"
      echo ""
      echo "Models: opus, sonnet46, sonnet45, haiku, codex, gemini, glm, kimi (default: all)"
      echo "Trials: number of trials per model (default: 1)"
      echo ""
      echo "Each model gets 30 min to iterate on combat scripts with fresh accounts."
      echo "Score = best combat level from any single run within the 30 minutes."
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

# Default to all if none specified
if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="opus sonnet46 sonnet45 haiku codex gemini glm kimi"
fi

# Export API keys from .env
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a
  source "$SCRIPT_DIR/../.env"
  set +a
fi
GLM_KEY="${GLM_API_KEY:-}"

# ── Regenerate tasks ──────────────────────────────────────────────
echo "Regenerating benchmark tasks..."
bun "$SCRIPT_DIR/generate-tasks.ts"
echo ""

# ── Launch all models in parallel ─────────────────────────────────
TASK="combat-level-30m"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ALL_PIDS=""
ALL_JOBS=""

for model_name in $SELECTED_MODELS; do
  entry=$(lookup_model "$model_name")
  if [ -z "$entry" ]; then
    echo "Unknown model: $model_name (available: opus, sonnet46, sonnet45, haiku, codex, gemini, glm, kimi)"
    exit 1
  fi

  IFS='|' read -r agent model label <<< "$entry"

  # GLM needs custom env
  ENV_PREFIX=""
  AGENT_FLAG="-a '$agent'"
  HARBOR_ENV="modal"
  if [ "$model_name" = "glm" ]; then
    if [ -z "$GLM_KEY" ]; then
      echo "  WARNING: GLM_API_KEY not found in .env, skipping glm"
      continue
    fi
    ENV_PREFIX="ANTHROPIC_API_KEY=$GLM_KEY ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic API_TIMEOUT_MS=3000000"
  elif [ "$model_name" = "kimi" ]; then
    if [ -z "$OPENROUTER_API_KEY" ]; then
      echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping kimi"
      continue
    fi
    ENV_PREFIX="PYTHONPATH=$SCRIPT_DIR:\${PYTHONPATH:-}"
    AGENT_FLAG="--agent-import-path 'kimi_adapter:KimiOpenCode'"
    HARBOR_ENV="modal"
  fi

  JOB_NAME="${TASK}-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"

  echo "  Launching: $model_name → $LOG_FILE"

  eval "$ENV_PREFIX harbor run \
    -p '$SCRIPT_DIR/tasks/$TASK' \
    $AGENT_FLAG \
    -m '$model' \
    --job-name '$JOB_NAME' \
    --env $HARBOR_ENV \
    -n 1 \
    -k $TRIALS \
    $EXTRA_ARGS" > "$LOG_FILE" 2>&1 &

  PID=$!
  ALL_PIDS="$ALL_PIDS $PID"
  ALL_JOBS="$ALL_JOBS
$PID|$model_name|$label"
done

TOTAL=$(echo $ALL_PIDS | wc -w | tr -d ' ')
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Waiting for $TOTAL model runs to finish..."
echo "  Task: $TASK (30 min agent time + fresh accounts)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

TOTAL_FAILED=0
for pid in $ALL_PIDS; do
  if ! wait "$pid"; then
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi
done

# ── Print summary ─────────────────────────────────────────────────
echo ""
echo "Results:"
for model_name in $SELECTED_MODELS; do
  entry=$(lookup_model "$model_name")
  [ -z "$entry" ] && continue
  IFS='|' read -r _agent _model label <<< "$entry"

  JOB_NAME="${TASK}-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"
  if [ -f "$LOG_FILE" ]; then
    LAST_LINES=$(tail -5 "$LOG_FILE" 2>/dev/null || echo "(no output)")
    echo "  $model_name:"
    echo "$LAST_LINES" | sed 's/^/    /'
    echo ""
  fi
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$TOTAL_FAILED" -eq 0 ]; then
  echo "All combat-level benchmarks complete. ($TOTAL models)"
else
  echo "All runs finished. $TOTAL_FAILED of $TOTAL run(s) had errors."
fi
echo ""
echo "Next steps:"
echo "  bun benchmark/extract-combat-results.ts"
