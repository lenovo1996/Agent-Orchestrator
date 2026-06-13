#!/usr/bin/env bash
# runtimes/codex.sh — Codex CLI runtime wrapper
# Token output format: "tokens used\n<number>"
set -euo pipefail

PROMPT_FILE="$1"
LOG_FILE="$2"
WORK_DIR="$3"
CWD="$4"

# Runtime-specific env vars
CODEX_MODEL="${AGENT_MODEL:-gpt-5.5}"
CODEX_REASONING="${AGENT_REASONING:-high}"

{
  echo "Runtime: codex"
  echo "Model: $CODEX_MODEL"
  echo "Reasoning: $CODEX_REASONING"
} | tee -a "$LOG_FILE"

cd "$CWD"

set +e
codex \
  --dangerously-bypass-approvals-and-sandbox \
  -m "$CODEX_MODEL" \
  -c "model_reasoning_effort=\"$CODEX_REASONING\"" \
  exec - < "$PROMPT_FILE" 2>&1 | tee -a "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -e

exit $EXIT_CODE
