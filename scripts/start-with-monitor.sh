#!/usr/bin/env bash
# start-with-monitor.sh - Start workflow with tmux monitoring dashboard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SKILL_DIR/.." && pwd)"

start_tmux_refresh_loop() {
  local target="$1"
  local refresh_script="$WORK_DIR/scripts/tmux-refresh-loop.sh"
  mkdir -p "$WORK_DIR/scripts"
  cat > "$refresh_script" <<'REFRESH_EOF'
#!/usr/bin/env bash
set -euo pipefail
TARGET="$1"
while tmux has-session -t "$TARGET" 2>/dev/null || tmux list-panes -t "$TARGET" >/dev/null 2>&1; do
  tmux refresh-client -S 2>/dev/null || true
  sleep 1
 done
REFRESH_EOF
  chmod +x "$refresh_script"
  "$refresh_script" "$target" >/dev/null 2>&1 &
}

setup_tmux_navigation() {
  # Enable mouse mode and pane navigation when tmux server is available.
  # Ignore failures so monitor can create a new server/session cleanly.
  tmux set-option -g mouse on 2>/dev/null || true

  # Alt+Arrow for pane navigation (no prefix needed)
  tmux bind-key -n M-Left select-pane -L 2>/dev/null || true
  tmux bind-key -n M-Right select-pane -R 2>/dev/null || true
  tmux bind-key -n M-Up select-pane -U 2>/dev/null || true
  tmux bind-key -n M-Down select-pane -D 2>/dev/null || true

  # Ctrl+Arrow for pane navigation (alternative)
  tmux bind-key -n C-Left select-pane -L 2>/dev/null || true
  tmux bind-key -n C-Right select-pane -R 2>/dev/null || true
  tmux bind-key -n C-Up select-pane -U 2>/dev/null || true
  tmux bind-key -n C-Down select-pane -D 2>/dev/null || true
}


if [[ $# -lt 1 ]]; then
  echo "Usage: $0 [jira-key] --prompt 'custom prompt'"
  echo ""
  echo "Examples:"
  echo "  $0 JH-39967"
  echo "  $0 JH-39967 --prompt 'Write unit tests for all changes'"
  echo "  $0 --prompt 'Custom task without Jira key'"
  exit 1
fi

JIRA_KEY=""
CUSTOM_PROMPT=""

# Parse args: optional jira key + optional --prompt
if [[ "$1" != --* ]]; then
  JIRA_KEY="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case $1 in
    --prompt)
      CUSTOM_PROMPT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$JIRA_KEY" && -z "$CUSTOM_PROMPT" ]]; then
  echo "❌ Error: must provide either jira-key or --prompt"
  exit 1
fi

# Verify environment before starting workflow
"$SCRIPT_DIR/check-env.sh" || exit 1

# Confirm current branches before starting workflow
"$SCRIPT_DIR/show-branches.sh"
read -r -p "Continue dev-team workflow with these branches? [y/N] " confirm
case "$confirm" in
  y|Y|yes|YES)
    echo "✅ Continuing..."
    ;;
  *)
    echo "🛑 Cancelled before starting workflow."
    exit 0
    ;;
esac
echo ""

# Start workflow
if [[ -n "$JIRA_KEY" ]]; then
  echo "🚀 Starting workflow for $JIRA_KEY..."
else
  echo "🚀 Starting ad-hoc workflow..."
fi

if [[ -n "$CUSTOM_PROMPT" ]]; then
  echo "📝 Custom prompt: $CUSTOM_PROMPT"
fi

if [[ -n "$JIRA_KEY" ]]; then
  if [[ -n "$CUSTOM_PROMPT" ]]; then
    FLOW_OUTPUT=$(node "$SCRIPT_DIR/orchestrator.js" start "$JIRA_KEY" "$CUSTOM_PROMPT")
  else
    FLOW_OUTPUT=$(node "$SCRIPT_DIR/orchestrator.js" start "$JIRA_KEY")
  fi
else
  FLOW_OUTPUT=$(node "$SCRIPT_DIR/orchestrator.js" start "" "$CUSTOM_PROMPT")
fi
FLOW_ID=$(echo "$FLOW_OUTPUT" | grep "Workflow started:" | awk '{print $NF}')

if [[ -z "$FLOW_ID" ]]; then
  echo "❌ Failed to start workflow"
  exit 1
fi

echo "✅ Workflow started: $FLOW_ID"
if [[ -n "$CUSTOM_PROMPT" ]]; then
  echo "📝 Custom: $CUSTOM_PROMPT"
fi
echo ""
echo "🚀 Spawning Clarifier via Gateway API..."
node "$SCRIPT_DIR/spawn-via-gateway.js" "$FLOW_ID" &
SPAWN_PID=$!
echo "   Spawn process: $SPAWN_PID"
echo ""
echo "👀 Starting watcher for auto-spawn..."
mkdir -p "$REPO_ROOT/.dev-team/task-flows/$FLOW_ID/logs"
node "$SCRIPT_DIR/watcher.js" "$FLOW_ID" >> "$REPO_ROOT/.dev-team/task-flows/$FLOW_ID/logs/watcher.log" 2>&1 &
WATCHER_PID=$!
echo "   Watcher process: $WATCHER_PID"
echo "   Watcher log: .dev-team/task-flows/$FLOW_ID/logs/watcher.log"

WORK_DIR="$REPO_ROOT/.dev-team/task-flows/$FLOW_ID"

# Check if already inside tmux
if [ -n "${TMUX:-}" ]; then
  setup_tmux_navigation
  echo "📺 Creating 4-pane layout: header (80% dashboard | 20% codex) | bottom (80% log | 20% helper)..."

  # Split vertical first: header 80% / bottom 20%
  tmux split-window -v -l 50%

  # Capture header and bottom pane IDs
  HEADER_PANE=$(tmux list-panes -F '#{pane_id}' | sed -n 1p)
  BOTTOM_PANE=$(tmux list-panes -F '#{pane_id}' | sed -n 2p)

  # Split header horizontally: dashboard 40% | codex 40%
  tmux split-window -h -l 40% -t "$HEADER_PANE"

  # Split bottom horizontally: log 40% | helper 40%
  tmux split-window -h -l 40% -t "$BOTTOM_PANE"

  # Final pane order:
  # 0: header-left dashboard
  # 1: header-right codex
  # 2: bottom-left live log
  # 3: bottom-right helper

  PANE_LIST=($(tmux list-panes -F '#{pane_id}'))
  DASHBOARD_PANE="${PANE_LIST[0]}"
  CODEX_PANE="${PANE_LIST[1]}"
  LOG_PANE="${PANE_LIST[2]}"
  HELPER_PANE="${PANE_LIST[3]}"

  # Set pane titles
  tmux select-pane -t "$DASHBOARD_PANE" -T "Dashboard"
  tmux select-pane -t "$CODEX_PANE" -T "Codex"
  tmux select-pane -t "$LOG_PANE" -T "Live Log"
  tmux select-pane -t "$HELPER_PANE" -T "Helper"

  # Start dashboard in top-left with 1s interval (reduce flicker)
  tmux send-keys -t "$DASHBOARD_PANE" "python3 '$SCRIPT_DIR/dashboard.py' '$FLOW_ID' 0.1" Enter

  # Generate helper script from template
  mkdir -p "$WORK_DIR/scripts"
  sed -e "s|__FLOW_ID__|$FLOW_ID|g" \
      -e "s|__WORK_DIR__|$WORK_DIR|g" \
      -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" \
      -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
      "$SCRIPT_DIR/tmux-helper-template.sh" > "$WORK_DIR/scripts/tmux-helper.sh"
  chmod +x "$WORK_DIR/scripts/tmux-helper.sh"

  # Start helper in bottom-right
  tmux send-keys -t "$HELPER_PANE" "$WORK_DIR/scripts/tmux-helper.sh" Enter

  # Pane 1: header-right codex cli
  tmux send-keys -t "$SESSION_NAME:0.1" "cd '$REPO_ROOT' && clear && codex" Enter

  # Start live log tail in bottom-left
  LOG_DIR="$WORK_DIR/logs"
  mkdir -p "$LOG_DIR"
  CURRENT_LOG="$LOG_DIR/current.log"
  touch "$CURRENT_LOG"
  tmux send-keys -t "$LOG_PANE" "python3 '$SCRIPT_DIR/log-pretty.py' '$CURRENT_LOG' || echo 'Waiting for agent logs...'" Enter

  # Start background refresh loop to prevent layout corruption
  start_tmux_refresh_loop "$(tmux display-message -p '#{session_name}:#{window_index}')"

  echo ""
  echo "✅ Dashboard split in current window!"
  echo "   Top: dashboard | codex cli"
  echo "   Bottom: live log | helper"
  echo ""
  exit 0
fi

# Not in tmux: create new session
SESSION_NAME="devteam_${FLOW_ID}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "⚠️  Session $SESSION_NAME already exists. Attaching..."
  tmux attach-session -t "$SESSION_NAME"
  exit 0
fi

echo "📺 Creating new tmux session: $SESSION_NAME"

tmux new-session -d -s "$SESSION_NAME" -n "dashboard"

# New 4-pane layout:
# Header 80%: dashboard 40% | codex 40%
# Bottom 20%: live log 40% | helper 40%

# Split vertical first: header 80% / bottom 20%
tmux split-window -v -l 50% -t "$SESSION_NAME:0.0"

# Capture header and bottom pane IDs after split
HEADER_PANE=$(tmux list-panes -t "$SESSION_NAME:0" -F '#{pane_id}' | sed -n 1p)
BOTTOM_PANE=$(tmux list-panes -t "$SESSION_NAME:0" -F '#{pane_id}' | sed -n 2p)

# Split header horizontally: dashboard left 40% / codex right 40%
tmux split-window -h -l 40% -t "$HEADER_PANE"

# Split bottom horizontally: live log left 40% / helper right 40%
tmux split-window -h -l 40% -t "$BOTTOM_PANE"

# Pane order:
# 0: header-left dashboard
# 1: header-right codex
# 2: bottom-left live log
# 3: bottom-right helper

tmux send-keys -t "$SESSION_NAME:0.0" "python3 '$SCRIPT_DIR/dashboard.py' '$FLOW_ID' 0.1" Enter

# Generate helper script from template
mkdir -p "$WORK_DIR/scripts"
sed -e "s|__FLOW_ID__|$FLOW_ID|g" \
    -e "s|__WORK_DIR__|$WORK_DIR|g" \
    -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" \
    -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
    "$SCRIPT_DIR/tmux-helper-template.sh" > "$WORK_DIR/scripts/tmux-helper.sh"
chmod +x "$WORK_DIR/scripts/tmux-helper.sh"
# Pane 3: bottom-right helper
tmux send-keys -t "$SESSION_NAME:0.3" "$WORK_DIR/scripts/tmux-helper.sh" Enter

# Pane 1: header-right codex cli
tmux send-keys -t "$SESSION_NAME:0.1" "cd '$REPO_ROOT' && clear && codex" Enter

# Pane 2: bottom-left live log
LOG_DIR="$WORK_DIR/logs"
mkdir -p "$LOG_DIR"
CURRENT_LOG="$LOG_DIR/current.log"
touch "$CURRENT_LOG"
tmux send-keys -t "$SESSION_NAME:0.2" "python3 '$SCRIPT_DIR/log-pretty.py' '$CURRENT_LOG' || echo 'Waiting for agent logs...'" Enter

# Second window: raw logs for people who want old mode
tmux new-window -t "$SESSION_NAME" -n "raw-files"
tmux send-keys -t "$SESSION_NAME:1.0" "cd '$WORK_DIR' && echo 'Raw output files' && ls -la output/ && echo '' && echo 'Use: less output/clarify.md / output/architecture.md / output/plan.md / output/implementation.md / output/verification.md' && zsh" Enter

tmux select-window -t "$SESSION_NAME:0"
tmux select-pane -t "$SESSION_NAME:0.0"

echo ""
echo "✅ Dashboard ready!"
echo ""
echo "📺 Attaching to tmux session: $SESSION_NAME"
echo ""
echo "Controls:"
echo "  - Ctrl+B then arrow keys: navigate panes"
echo "  - Ctrl+B then d: detach (workflow continues)"
echo "  - Ctrl+B then [: scroll mode (q to exit)"
echo "  - Ctrl+C in a pane: stop tail"
echo ""
echo "To reattach later:"
echo "  tmux attach-session -t $SESSION_NAME"
echo ""

sleep 2

# Start background refresh loop to prevent layout corruption
start_tmux_refresh_loop "$SESSION_NAME"

# Attach to session
tmux attach-session -t "$SESSION_NAME"
