#!/usr/bin/env bash
# agent-wrapper.sh — Universal agent wrapper (dispatches to runtime-specific scripts)
#
# Replaces codex-agent-wrapper.sh with a pluggable runtime system.
# Backward-compatible: defaults to "codex" runtime if not specified.
#
# Usage: agent-wrapper.sh <flow-id> <step> <work-dir> <prompt-file> [worktree-path]
#
# Env vars (set by spawn-via-gateway.js):
#   AGENT_RUNTIME      - runtime name: codex|claude|kiro|generic (default: codex)
#   AGENT_MODEL        - model to use
#   AGENT_REASONING    - reasoning effort
#   AGENT_COMMAND      - custom command (generic runtime only)
set -euo pipefail

if [ $# -lt 4 ]; then
  echo "Usage: $0 <flow-id> <step> <work-dir> <prompt-file> [worktree-path]"
  exit 1
fi

FLOW_ID="$1"
STEP="$2"
WORK_DIR="$3"
PROMPT_FILE="$4"
WORKTREE_PATH="${5:-}"

# Derive paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME="${AGENT_RUNTIME:-codex}"
RUNTIME_SCRIPT="$SCRIPT_DIR/../runtimes/${RUNTIME}.sh"

# Validate worktree path if provided
if [ -n "$WORKTREE_PATH" ]; then
  if [ ! -d "$WORKTREE_PATH" ]; then
    echo "❌ Worktree path does not exist: $WORKTREE_PATH" | tee -a "${WORK_DIR}/logs/${STEP}.log" 2>/dev/null || true
    exit 1
  fi
  if ! git -C "$WORKTREE_PATH" rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Not a valid git worktree: $WORKTREE_PATH" | tee -a "${WORK_DIR}/logs/${STEP}.log" 2>/dev/null || true
    exit 1
  fi
fi

# Validate runtime script exists
if [ ! -f "$RUNTIME_SCRIPT" ]; then
  echo "❌ Unknown runtime: $RUNTIME (no script at $RUNTIME_SCRIPT)" >&2
  echo "   Available runtimes: $(ls "$SCRIPT_DIR/../runtimes/" | sed 's/\.sh$//' | tr '\n' ' ')" >&2
  exit 1
fi

# Setup directories and log
LOG_DIR="$WORK_DIR/logs"
mkdir -p "$LOG_DIR" "$WORK_DIR/output" "$WORK_DIR/prompts" "$WORK_DIR/scripts"
LOG_FILE="$LOG_DIR/${STEP}.log"
CURRENT_LINK="$LOG_DIR/current.log"
ln -sfn "${STEP}.log" "$CURRENT_LINK"

# Resolve output file path from team.json
SKILL_DIR="$REPO_ROOT"
OUTPUT_FILE="$WORK_DIR/$(node -e "
  const t = require('$SKILL_DIR/team.json');
  process.stdout.write(t.members['$STEP'].outputs[0]);
")"

# Working directory for the agent
CWD="${WORKTREE_PATH:-$REPO_ROOT}"

# Write log header
{
  echo "=== Dev Team Agent Stream ==="
  echo "Flow: $FLOW_ID"
  echo "Agent: $STEP"
  echo "Started: $(date)"
  echo "Work dir: $WORK_DIR"
  echo "Prompt: $PROMPT_FILE"
  echo "Repo: $REPO_ROOT"
  echo "Worktree: ${WORKTREE_PATH:-none}"
  echo "Runtime: $RUNTIME"
  echo "Model: ${AGENT_MODEL:-default}"
  echo "Reasoning: ${AGENT_REASONING:-default}"
  echo "================================"
  echo ""
} | tee -a "$LOG_FILE"

# Crash sentinel: write ## Status FAILED if runtime exits non-zero and no output
write_crash_sentinel() {
  local code="$1"
  if [ "$code" -ne 0 ] && [ "$code" -ne 130 ] && [ "$code" -ne 143 ] && [ ! -s "$OUTPUT_FILE" ]; then
    cat > "$OUTPUT_FILE" <<SENTINEL
## Status FAILED

Exit code: $code
Runtime: $RUNTIME

Wrapper detected agent CLI exit with non-zero code and no output file.
This is an automated crash sentinel. See logs/$STEP.log for details.

_Written by agent-wrapper.sh trap_
SENTINEL
    echo "💀 Crash sentinel written: $OUTPUT_FILE" | tee -a "$LOG_FILE"
  fi
}

CLEANING_UP=0

# Propagate signals to entire process group so child CLI (kiro-cli, codex, etc.) gets killed
cleanup() {
  local sig="$1"
  if [ "$CLEANING_UP" -eq 1 ]; then
    exit 143
  fi
  CLEANING_UP=1
  trap '' TERM INT
  echo "" | tee -a "$LOG_FILE"
  echo "🛑 Received SIG${sig}, terminating child processes..." | tee -a "$LOG_FILE"
  # Kill all processes in our process group
  kill -"$sig" 0 2>/dev/null || true
  exit 143
}

trap 'cleanup TERM' TERM
trap 'cleanup INT' INT
trap 'write_crash_sentinel $?' EXIT

# Dispatch to runtime-specific script
set +e
bash "$RUNTIME_SCRIPT" "$PROMPT_FILE" "$LOG_FILE" "$WORK_DIR" "$CWD"
EXIT_CODE=$?
set -e

# Write log footer
{
  echo ""
  echo "================================"
  echo "Finished: $(date)"
  echo "Exit code: $EXIT_CODE"
  echo "Runtime: $RUNTIME"
} | tee -a "$LOG_FILE"

# Cleanup PID file
PID_FILE="$WORK_DIR/.pid.${STEP}"
rm -f "$PID_FILE"

exit $EXIT_CODE
