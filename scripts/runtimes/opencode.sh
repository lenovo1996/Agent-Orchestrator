#!/usr/bin/env bash
# runtimes/opencode.sh — OpenCode CLI runtime wrapper (v1.17.13+)
# Uses built-in opencode free models or 9router custom provider
#
# Env vars:
#   AGENT_MODEL        - model override (default: 9router/ocg/mimo-v2.5-pro)
#   AGENT_REASONING    - not used (reserved)
set -euo pipefail

PROMPT_FILE="$1"
LOG_FILE="$2"
WORK_DIR="$3"
CWD="$4"

OPENCODE_BIN="${OPENCODE_BIN:-$(which opencode 2>/dev/null || echo "$HOME/.nvm/versions/node/v24.16.0/bin/opencode")}"
MODEL="${AGENT_MODEL:-9router/ocg/mimo-v2.5-pro}"

{
  echo "Runtime: opencode (v1.17.13+)"
  echo "Model: $MODEL"
} >> "$LOG_FILE"

cd "$CWD"

PROMPT_CONTENT="$(cat "$PROMPT_FILE")"

set +e
"$OPENCODE_BIN" run \
  -m "$MODEL" \
  --auto \
  "$PROMPT_CONTENT" \
  2>&1 | tee -a "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -e

exit $EXIT_CODE
