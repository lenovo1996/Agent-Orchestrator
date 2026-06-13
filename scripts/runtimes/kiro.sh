#!/usr/bin/env bash
# runtimes/kiro.sh — Kiro CLI runtime wrapper
# Uses kiro-cli headless mode (--no-interactive) for automated agent execution.
# Token output format: "▸ Credits: <number> • Time: <duration>"
#
# Env vars:
#   AGENT_MODEL        - model override (default: claude-sonnet-4.6)
#   AGENT_REASONING    - reasoning effort (mapped to --effort)
#   KIRO_API_KEY       - API key for headless authentication
set -euo pipefail

PROMPT_FILE="$1"
LOG_FILE="$2"
WORK_DIR="$3"
CWD="$4"

KIRO_MODEL="${AGENT_MODEL:-claude-sonnet-4.6}"
KIRO_EFFORT="${AGENT_REASONING:-high}"

{
  echo "Runtime: kiro"
  echo "Model: $KIRO_MODEL"
  echo "Effort: $KIRO_EFFORT"
} | tee -a "$LOG_FILE"

cd "$CWD"

# Build args
KIRO_ARGS=(
  --no-interactive
  --trust-all-tools
  --wrap never
  --model "$KIRO_MODEL"
  --effort "$KIRO_EFFORT"
)

PROMPT_CONTENT="$(cat "$PROMPT_FILE")"

set +e
kiro-cli chat "${KIRO_ARGS[@]}" "$PROMPT_CONTENT" 2>&1 | tee -a "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -e

exit $EXIT_CODE
