#!/usr/bin/env bash
# runtimes/generic.sh — Generic CLI runtime wrapper
# Use this as a template or fallback for any CLI that accepts a prompt file via stdin.
#
# Configure via team.json:
#   "runtime": "generic"
#   "runtimeCommand": "my-cli --flag"
#
# The wrapper will execute: $AGENT_COMMAND < prompt-file
# Token output: auto-detected by token-tracker from log content.
#
# Env vars:
#   AGENT_COMMAND      - (required) the full CLI command to execute
#   AGENT_MODEL        - passed as env var to the child process
#   AGENT_REASONING    - passed as env var to the child process
set -euo pipefail

PROMPT_FILE="$1"
LOG_FILE="$2"
WORK_DIR="$3"
CWD="$4"

if [ -z "${AGENT_COMMAND:-}" ]; then
  echo "❌ AGENT_COMMAND not set. Configure 'runtimeCommand' in team.json." | tee -a "$LOG_FILE"
  exit 1
fi

{
  echo "Runtime: generic"
  echo "Command: $AGENT_COMMAND"
  echo "Model: ${AGENT_MODEL:-default}"
} | tee -a "$LOG_FILE"

cd "$CWD"

set +e
eval "$AGENT_COMMAND" < "$PROMPT_FILE" 2>&1 | tee -a "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -e

exit $EXIT_CODE
