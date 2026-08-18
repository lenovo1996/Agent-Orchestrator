#!/usr/bin/env bash
# runtimes/codex.sh — Codex CLI runtime wrapper
# Token output format: "tokens used\n<number>"
set -euo pipefail

PROMPT_FILE="$1"
LOG_FILE="$2"
WORK_DIR="$3"
CWD="$4"
FLOW_ID="$5"
STEP="$6"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE_HELPER="$SCRIPT_DIR/session-capture.js"

# Runtime-specific env vars
CODEX_MODEL="${AGENT_MODEL:-gpt-5.5}"
CODEX_REASONING="${AGENT_REASONING:-high}"

{
  echo "Runtime: codex"
  echo "Model: $CODEX_MODEL"
  echo "Reasoning: $CODEX_REASONING"
} | tee -a "$LOG_FILE"

cd "$CWD"

RUN_ID="$(node "$CAPTURE_HELPER" init \
  --work-dir "$WORK_DIR" \
  --flow-id "$FLOW_ID" \
  --step "$STEP" \
  --run-id "${DEVTEAM_SESSION_RUN_ID:-$(node -e "process.stdout.write(require('node:crypto').randomUUID())")}" \
  --attempt-id "${DEVTEAM_ATTEMPT_ID:-manual-${FLOW_ID}-${STEP}}" \
  --inngest-run-id "${DEVTEAM_INNGEST_RUN_ID:-manual-${FLOW_ID}}" \
  --inngest-attempt "${DEVTEAM_INNGEST_ATTEMPT:-0}")"
STDERR_FILE="$(mktemp "${TMPDIR:-/tmp}/codex-session-stderr.XXXXXX")"
cleanup_capture_file() {
  rm -f "$STDERR_FILE"
}
trap cleanup_capture_file EXIT

set +e
codex \
  --dangerously-bypass-approvals-and-sandbox \
  -m "$CODEX_MODEL" \
  -c "model_reasoning_effort=\"$CODEX_REASONING\"" \
  exec --json - < "$PROMPT_FILE" \
  2> >(tee -a "$STDERR_FILE" "$LOG_FILE" >&2) \
  | node "$CAPTURE_HELPER" stream \
      --work-dir "$WORK_DIR" \
      --step "$STEP" \
      --run-id "$RUN_ID" \
  | tee -a "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -e

if ! node "$CAPTURE_HELPER" finalize \
  --work-dir "$WORK_DIR" \
  --step "$STEP" \
  --run-id "$RUN_ID" \
  --exit-code "$EXIT_CODE" \
  --stderr-file "$STDERR_FILE"; then
  echo "⚠️ Failed to finalize structured session metadata for run $RUN_ID" | tee -a "$LOG_FILE"
fi

exit $EXIT_CODE
