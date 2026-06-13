#!/usr/bin/env bash
# runtimes/claude.sh — Claude Code CLI runtime wrapper
# Runs claude in print mode with JSON output for structured token tracking.
# Token output format: JSON with "usage" and "total_cost_usd" fields.
#
# Env vars:
#   AGENT_MODEL        - model override (default: claude-sonnet-4-20250514)
#   AGENT_REASONING    - not used by claude CLI (reserved)
#   AGENT_MAX_TURNS    - max turns (default: unlimited)
#   AGENT_PERMISSION   - permission mode (default: dangerously-skip-permissions)
set -euo pipefail

PROMPT_FILE="$1"
LOG_FILE="$2"
WORK_DIR="$3"
CWD="$4"

CLAUDE_MODEL="${AGENT_MODEL:-claude-sonnet-4-20250514}"
CLAUDE_PERMISSION="${AGENT_PERMISSION:-dangerously-skip-permissions}"
CLAUDE_MAX_TURNS="${AGENT_MAX_TURNS:-}"

{
  echo "Runtime: claude"
  echo "Model: $CLAUDE_MODEL"
  echo "Permission: $CLAUDE_PERMISSION"
} | tee -a "$LOG_FILE"

cd "$CWD"

# Build args
CLAUDE_ARGS=(
  -p
  --model "$CLAUDE_MODEL"
  --permission-mode "$CLAUDE_PERMISSION"
  --output-format json
)

if [ -n "$CLAUDE_MAX_TURNS" ]; then
  CLAUDE_ARGS+=(--max-turns "$CLAUDE_MAX_TURNS")
fi

PROMPT_CONTENT="$(cat "$PROMPT_FILE")"

set +e
claude "${CLAUDE_ARGS[@]}" "$PROMPT_CONTENT" 2>&1 | tee -a "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -e

exit $EXIT_CODE
