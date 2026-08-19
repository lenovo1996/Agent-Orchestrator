#!/usr/bin/env bash
# runtimes/appserver.sh — App-server runtime wrapper
# Connects to codex app-server daemon via WebSocket instead of spawning codex CLI.
set -euo pipefail

PROMPT_FILE="$1"
LOG_FILE="$2"
WORK_DIR="$3"
CWD="$4"
FLOW_ID="$5"
STEP="$6"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_SCRIPT="$SCRIPT_DIR/appserver-runtime.js"

{
  echo "Runtime: appserver"
  echo "URL: ${CODEX_APP_SERVER_URL:-default (unix socket)}"
} | tee -a "$LOG_FILE"

cd "$CWD"

set +e
node "$RUNTIME_SCRIPT" "$PROMPT_FILE" "$LOG_FILE" "$WORK_DIR" "$CWD" "$FLOW_ID" "$STEP" \
  2> >(tee -a "$LOG_FILE" >&2)
EXIT_CODE=$?
set -e

exit $EXIT_CODE
