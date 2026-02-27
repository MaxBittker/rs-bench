#!/bin/bash
# Run 10-minute skill XP benchmarks across models.
#
# All models and skills launch in parallel.
# Wall clock: ~15 min for everything.
#
# Usage:
#   run-skills-10m.sh                      # all models, all skills
#   run-skills-10m.sh -m haiku             # single model
#   run-skills-10m.sh -s woodcutting        # single skill
#   run-skills-10m.sh -m haiku -s woodcutting  # single skill + model
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

# ── Model definitions (agent|model-id|label) ────────────────────
ALL_MODELS="
claude-code|anthropic/claude-opus-4-6|opus
claude-code|anthropic/claude-opus-4-5|opus45
claude-code|anthropic/claude-sonnet-4-6|sonnet46
claude-code|anthropic/claude-sonnet-4-5|sonnet45
claude-code|anthropic/claude-haiku-4-5|haiku
codex|openai/gpt-5.2-codex|codex
codex|openai/gpt-5.3-codex|codex53
gemini-cli|google/gemini-3-pro-preview|gemini
gemini-cli|google/gemini-3.1-pro-preview|gemini31
claude-code|glm-5|glm
kimi-opencode|openrouter/moonshotai/kimi-k2.5|kimi
qwen3-opencode|openrouter/qwen/qwen3-coder-next|qwen3
qwen35-opencode|openrouter/qwen/qwen3.5-35b-a3b|qwen35

"

ALL_SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"

# ── Defaults ──────────────────────────────────────────────────────
SELECTED_MODELS=""
SELECTED_SKILLS=""
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)   SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -s|--skill)   SELECTED_SKILLS="$SELECTED_SKILLS $2"; shift 2 ;;
    -h|--help)
      echo "Usage: run-skills-10m.sh [-m model] [-s skill]"
      echo ""
      echo "Models: opus, opus45, sonnet46, sonnet45, haiku, codex, codex53, gemini, gemini31, glm, kimi, qwen3, qwen35 (default: all)"
      echo "Skills: attack, defence, strength, hitpoints, ranged, prayer, magic,"
      echo "        woodcutting, fishing, mining, cooking, fletching, crafting,"
      echo "        smithing, firemaking, thieving (default: all sixteen)"
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

# Default to all if none specified
if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="opus opus45 sonnet46 sonnet45 haiku codex codex53 gemini gemini31 glm kimi qwen3 qwen35"
fi
if [ -z "$SELECTED_SKILLS" ]; then
  SELECTED_SKILLS="$ALL_SKILLS"
fi

load_env "$REPO_ROOT/.env"
GLM_KEY="${GLM_API_KEY:-}"

regenerate_tasks "$REPO_ROOT/generate-tasks.ts"

# ── Launch all models × skills in parallel ──────────────────────────
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ALL_PIDS=""
ALL_JOBS=""  # "pid|model_name|skill" entries

for model_name in $SELECTED_MODELS; do
  entry=$(lookup_model "$model_name" "$ALL_MODELS")
  if [ -z "$entry" ]; then
    echo "Unknown model: $model_name (available: opus, opus45, sonnet46, sonnet45, haiku, codex, codex53, gemini, gemini31, glm, kimi, qwen3, qwen35)"
    exit 1
  fi

  IFS='|' read -r agent model label <<< "$entry"

  # Per-model config (reset each iteration)
  ENV_PREFIX=""
  AGENT_FLAG="-a '$agent'"
  HARBOR_ENV="modal"
  MODEL_EXTRA_ARGS=""

  if ! configure_model_env "$model_name" "$REPO_ROOT/agents" "$entry"; then
    continue
  fi

  # Model-specific overrides beyond configure_model_env
  #
  # run_timeout_sec prevents the harbor/Modal cancellation hang:
  #   - For opencode agents: sets the bash loop timeout (game time)
  #   - For codex: sets the Modal exec timeout (must be < harbor's 720s agent timeout)
  case "$model_name" in
    codex|codex53)
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=700"
      ;;
    kimi|qwen3|qwen35)
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=600"
      ;;
  esac
  if [ "$model_name" = "codex53" ]; then
    CODEX_AUTH_FILE="$HOME/.codex/auth.json"
    if [ ! -f "$CODEX_AUTH_FILE" ]; then
      echo "  WARNING: ~/.codex/auth.json not found, skipping codex53 (OAuth required)"
      continue
    fi
    ENV_PREFIX="$ENV_PREFIX CODEX_AUTH_JSON=\$(cat '$CODEX_AUTH_FILE')"
  fi

  for skill in $SELECTED_SKILLS; do
    TASK="${skill}-xp-10m"
    JOB_NAME="${TASK}-${label}-${TIMESTAMP}"
    LOG_FILE="/tmp/harbor-${JOB_NAME}.log"

    echo "  Launching: $model_name / $skill → $LOG_FILE"

    eval "$ENV_PREFIX harbor run \
      -p '$REPO_ROOT/tasks/$TASK' \
      $AGENT_FLAG \
      -m '$model' \
      --job-name '$JOB_NAME' \
      --env $HARBOR_ENV \
      -n 1 \
      -k 1 \
      $EXTRA_ARGS $MODEL_EXTRA_ARGS" > "$LOG_FILE" 2>&1 &

    PID=$!
    ALL_PIDS="$ALL_PIDS $PID"
    ALL_JOBS="$ALL_JOBS
$PID|$model_name|$skill|$label"
  done
done

TOTAL=$(echo $ALL_PIDS | wc -w | tr -d ' ')
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Waiting for $TOTAL runs to finish..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

TOTAL_FAILED=0
for pid in $ALL_PIDS; do
  if ! wait "$pid"; then
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi
done

# ── Print summary per model ─────────────────────────────────────────
echo ""
for model_name in $SELECTED_MODELS; do
  entry=$(lookup_model "$model_name" "$ALL_MODELS")
  [ -z "$entry" ] && continue
  IFS='|' read -r _agent _model label <<< "$entry"

  echo "  $model_name:"
  for skill in $SELECTED_SKILLS; do
    TASK="${skill}-xp-10m"
    LOG_FILE="/tmp/harbor-${TASK}-${label}-${TIMESTAMP}.log"
    if [ -f "$LOG_FILE" ]; then
      LAST_LINE=$(tail -1 "$LOG_FILE" 2>/dev/null || echo "")
      echo "    $skill: $LAST_LINE"
    fi
  done
  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$TOTAL_FAILED" -eq 0 ]; then
  echo "All skill benchmarks complete. ($TOTAL runs)"
else
  echo "All runs finished. $TOTAL_FAILED of $TOTAL run(s) had errors."
fi
echo ""
echo "Next steps:"
echo "  bun extractors/extract-skill-results.ts --horizon 10m"
echo "  open views/graph-skills.html?horizon=10m"
