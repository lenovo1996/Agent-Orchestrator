#!/usr/bin/env bash
# codex-agent-wrapper.sh - Run a dev-team agent via Codex CLI with realtime log
set -euo pipefail

if [ $# -lt 4 ]; then
  echo "Usage: $0 <flow-id> <step> <work-dir> <prompt-file>"
  exit 1
fi

FLOW_ID="$1"
STEP="$2"
WORK_DIR="$3"
PROMPT_FILE="$4"
WORKTREE_PATH="${5:-}"

# Derive repo root from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Validate worktree path if provided
if [ -n "$WORKTREE_PATH" ]; then
  if [ ! -d "$WORKTREE_PATH" ]; then
    echo "❌ Worktree path does not exist: $WORKTREE_PATH" | tee -a "${WORK_DIR}/logs/${STEP}.log" 2>/dev/null || echo "❌ Worktree path does not exist: $WORKTREE_PATH"
    exit 1
  fi
  # Validate it's a valid git worktree
  if ! git -C "$WORKTREE_PATH" rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Not a valid git worktree: $WORKTREE_PATH" | tee -a "${WORK_DIR}/logs/${STEP}.log" 2>/dev/null || echo "❌ Not a valid git worktree: $WORKTREE_PATH"
    exit 1
  fi
fi

LOG_DIR="$WORK_DIR/logs"
mkdir -p "$LOG_DIR"
mkdir -p "$WORK_DIR/output"
mkdir -p "$WORK_DIR/prompts"
mkdir -p "$WORK_DIR/scripts"
LOG_FILE="$LOG_DIR/${STEP}.log"
CURRENT_LINK="$LOG_DIR/current.log"
CODEX_MODEL="${CODEX_MODEL:-gpt-5.5}"
CODEX_REASONING="${CODEX_REASONING:-high}"

# Resolve output file path from team.json
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_FILE="$WORK_DIR/$(node -e "
  const t = require('$SKILL_DIR/team.json');
  process.stdout.write(t.members['$STEP'].outputs[0]);
")"

ln -sfn "${STEP}.log" "$CURRENT_LINK"

{
  echo "=== Dev Team Agent Stream ==="
  echo "Flow: $FLOW_ID"
  echo "Agent: $STEP"
  echo "Started: $(date)"
  echo "Work dir: $WORK_DIR"
  echo "Prompt: $PROMPT_FILE"
  echo "Repo: $REPO_ROOT"
  echo "Worktree: ${WORKTREE_PATH:-none}"
  echo "Model: $CODEX_MODEL"
  echo "Reasoning: $CODEX_REASONING"
  echo "================================"
  echo ""
} | tee "$LOG_FILE"

# Crash sentinel: write ## Status FAILED if codex exits non-zero and no output
write_crash_sentinel() {
  local code="$1"
  if [ "$code" -ne 0 ] && [ "$code" -ne 130 ] && [ "$code" -ne 143 ] && [ ! -s "$OUTPUT_FILE" ]; then
    cat > "$OUTPUT_FILE" <<SENTINEL
## Status FAILED

Exit code: $code

Wrapper detected codex CLI exit with non-zero code and no output file.
This is an automated crash sentinel. See logs/$STEP.log for details.

_Written by codex-agent-wrapper.sh trap_
SENTINEL
    echo "💀 Crash sentinel written: $OUTPUT_FILE" | tee -a "$LOG_FILE"
  fi
}

CLEANING_UP=0

# Propagate signals to entire process group so child CLI gets killed
cleanup() {
  local sig="$1"
  if [ "$CLEANING_UP" -eq 1 ]; then
    exit 143
  fi
  CLEANING_UP=1
  trap '' TERM INT
  echo "" | tee -a "$LOG_FILE"
  echo "🛑 Received SIG${sig}, terminating child processes..." | tee -a "$LOG_FILE"
  kill -"$sig" 0 2>/dev/null || true
  exit 143
}

trap 'cleanup TERM' TERM
trap 'cleanup INT' INT
trap 'write_crash_sentinel $?' EXIT

cd "${WORKTREE_PATH:-$REPO_ROOT}"

set +e
codex \
  --dangerously-bypass-approvals-and-sandbox \
  -m "$CODEX_MODEL" \
  -c "model_reasoning_effort=\"$CODEX_REASONING\"" \
  exec - < "$PROMPT_FILE" 2>&1 | tee -a "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -e

{
  echo ""
  echo "================================"
  echo "Finished: $(date)"
  echo "Exit code: $EXIT_CODE"
} | tee -a "$LOG_FILE"

# Cleanup PID file
PID_FILE="$WORK_DIR/.pid.${STEP}"
rm -f "$PID_FILE"

exit $EXIT_CODE
