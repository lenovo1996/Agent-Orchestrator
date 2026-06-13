#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/tmux-helper-template.sh"

echo "=== Helper Template Consistency Test ==="

# Test: template file exists
if [ ! -f "$TEMPLATE" ]; then
  echo "FAIL: Template file not found: $TEMPLATE"
  exit 1
fi
echo "PASS: Template file exists"

# Test: template contains placeholders
for placeholder in __FLOW_ID__ __WORK_DIR__ __SCRIPT_DIR__ __REPO_ROOT__; do
  if ! grep -q "$placeholder" "$TEMPLATE"; then
    echo "FAIL: Template missing placeholder: $placeholder"
    exit 1
  fi
  echo "PASS: Template has $placeholder"
done

# Test: template contains retry_step function
if ! grep -q "retry_step" "$TEMPLATE"; then
  echo "FAIL: Template missing retry_step function"
  exit 1
fi
echo "PASS: Template has retry_step function"

# Test: template has output existence check for 'r'
if ! grep -q '\-f.*output_file' "$TEMPLATE"; then
  echo "FAIL: Template missing -f output_file check for 'r' key"
  exit 1
fi
echo "PASS: Template has -f guard for 'r' key"

# Test: template calls lib/retry-flow
if ! grep -q "lib/retry-flow" "$TEMPLATE"; then
  echo "FAIL: Template doesn't use lib/retry-flow"
  exit 1
fi
echo "PASS: Template uses lib/retry-flow"

# Test: template has pgrep watcher
if ! grep -q "pgrep.*watcher" "$TEMPLATE"; then
  echo "FAIL: Template missing pgrep watcher check"
  exit 1
fi
echo "PASS: Template checks watcher via pgrep"

# Test: start-with-monitor.sh uses sed template substitution (not heredoc)
MONITOR="$SCRIPT_DIR/start-with-monitor.sh"
if grep -q "<<'HELPER_EOF'" "$MONITOR"; then
  echo "FAIL: start-with-monitor.sh still has HELPER_EOF heredoc"
  exit 1
fi
echo "PASS: No HELPER_EOF heredoc in start-with-monitor.sh"

# Test: both branches use the same sed command
SED_COUNT=$(grep -c "tmux-helper-template.sh" "$MONITOR" || true)
if [ "$SED_COUNT" -lt 2 ]; then
  echo "FAIL: Expected template referenced at least twice in start-with-monitor.sh (both branches), found $SED_COUNT"
  exit 1
fi
echo "PASS: Template referenced $SED_COUNT times in start-with-monitor.sh (both branches)"

# Test: sed produces consistent output for both branches
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

sed -e "s|__FLOW_ID__|FLOW_A|g" \
    -e "s|__WORK_DIR__|/tmp/work_a|g" \
    -e "s|__SCRIPT_DIR__|/tmp/scripts|g" \
    -e "s|__REPO_ROOT__|/tmp/repo|g" \
    "$TEMPLATE" > "$TMPDIR/helper_a.sh"

sed -e "s|__FLOW_ID__|FLOW_B|g" \
    -e "s|__WORK_DIR__|/tmp/work_b|g" \
    -e "s|__SCRIPT_DIR__|/tmp/scripts|g" \
    -e "s|__REPO_ROOT__|/tmp/repo|g" \
    "$TEMPLATE" > "$TMPDIR/helper_b.sh"

# Only difference should be FLOW_ID and WORK_DIR values
DIFF_OUTPUT=$(diff "$TMPDIR/helper_a.sh" "$TMPDIR/helper_b.sh" || true)
DIFF_LINES=$(echo "$DIFF_OUTPUT" | grep "^[<>]" | wc -l)
# Should only differ in lines containing the flow-specific values
if [ "$DIFF_LINES" -gt 10 ]; then
  echo "FAIL: Too many differences ($DIFF_LINES lines) between two generated helpers"
  exit 1
fi
echo "PASS: Generated helpers differ only in placeholder values ($DIFF_LINES lines)"

echo ""
echo "=== ALL TESTS PASSED ==="
