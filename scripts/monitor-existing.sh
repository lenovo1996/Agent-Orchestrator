#!/usr/bin/env bash
set -euo pipefail

# Derive paths from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

start_tmux_refresh_loop() {
  local target="$1"
  local refresh_script="$WORK_DIR/tmux-refresh-loop.sh"
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

FLOW_ROOT="$REPO_ROOT/.dev-team/task-flows"

if [[ $# -lt 1 ]]; then
  echo "📂 Available flows:"
  echo ""

  # List flows with creation time
  flows=($(ls -1dt "$FLOW_ROOT"/flow_* 2>/dev/null))

  if [ ${#flows[@]} -eq 0 ]; then
    echo "❌ No flows found in $FLOW_ROOT"
    exit 1
  fi

  echo "┌────┬─────────────────────────────────────┬─────────────┬──────────────────┐"
  echo "│ #  │ Flow ID                             │ Jira        │ Created          │"
  echo "├────┼─────────────────────────────────────┼─────────────┼──────────────────┤"

  idx=1
  for flow_path in "${flows[@]}"; do
    flow_id=$(basename "$flow_path")
    workflow_json="$flow_path/workflow.json"

    if [ -f "$workflow_json" ]; then
      jira_key=$(jq -r '.jiraKey // "N/A"' "$workflow_json" 2>/dev/null || echo "N/A")
      created=$(jq -r '.createdAt // "N/A"' "$workflow_json" 2>/dev/null || echo "N/A")

      # Format timestamp if it's ISO
      if [[ "$created" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2} ]]; then
        created=$(date -d "$created" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "$created")
      fi
    else
      jira_key="N/A"
      created="N/A"
    fi

    printf "│ %-2s │ %-35s │ %-11s │ %-16s │\n" "$idx" "$flow_id" "$jira_key" "$created"
    idx=$((idx + 1))

    # Limit to 20 recent flows
    if [ $idx -gt 20 ]; then
      break
    fi
  done

  echo "└────┴─────────────────────────────────────┴─────────────┴──────────────────┘"
  echo ""
  echo "Select flow number (or press Ctrl+C to cancel):"
  read -r selection

  if [[ ! "$selection" =~ ^[0-9]+$ ]] || [ "$selection" -lt 1 ] || [ "$selection" -gt ${#flows[@]} ]; then
    echo "❌ Invalid selection"
    exit 1
  fi

  selected_flow="${flows[$((selection - 1))]}"
  FLOW_ID=$(basename "$selected_flow")
  echo ""
  echo "✅ Selected: $FLOW_ID"
  echo ""
else
  FLOW_ID="$1"
fi
WORK_DIR="$FLOW_ROOT/$FLOW_ID"
SESSION_NAME="devteam_${FLOW_ID}"

if [[ ! -d "$WORK_DIR" ]]; then
  echo "❌ Flow work dir not found: $WORK_DIR"
  echo ""
  echo "Recent flows:"
  ls -1dt "$FLOW_ROOT"/flow_* 2>/dev/null | head -10 | xargs -r -n1 basename
  exit 1
fi

if [[ ! -f "$WORK_DIR/workflow.json" ]]; then
  echo "❌ workflow.json not found: $WORK_DIR/workflow.json"
  exit 1
fi

# Check and auto-start watcher if not running
if ! pgrep -f "watcher.js $FLOW_ID" >/dev/null 2>&1; then
  echo "🔄 Watcher not running, starting it now..."
  LOG_DIR="$WORK_DIR/logs"
  mkdir -p "$LOG_DIR"
  nohup node "$SCRIPT_DIR/watcher.js" "$FLOW_ID" > "$LOG_DIR/watcher.log" 2>&1 &
  WATCHER_PID=$!
  echo "✅ Watcher started: PID $WATCHER_PID"
  sleep 1
else
  echo "✅ Watcher already running"
fi

setup_tmux_navigation

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  PANE_COUNT=$(tmux list-panes -t "$SESSION_NAME:0" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$PANE_COUNT" -lt 3 ]]; then
    echo "🔧 Existing session has $PANE_COUNT pane(s). Adding live-log bottom pane..."
    LOG_DIR="$WORK_DIR/logs"
    mkdir -p "$LOG_DIR"
    CURRENT_LOG="$LOG_DIR/current.log"
    touch "$CURRENT_LOG"
    tmux split-window -v -l 25% -t "$SESSION_NAME:0.0" "python3 '$SCRIPT_DIR/log-pretty.py' '$CURRENT_LOG' || echo 'Waiting for agent logs...'"
    tmux select-layout -t "$SESSION_NAME:0" tiled >/dev/null 2>&1 || true
  fi
  start_tmux_refresh_loop "$SESSION_NAME"
  echo "📺 Attaching existing tmux session: $SESSION_NAME"
  tmux attach-session -t "$SESSION_NAME"
  exit 0
fi

echo "📺 Creating dashboard for existing flow: $FLOW_ID"
echo "   Work dir: $WORK_DIR"

tmux new-session -d -s "$SESSION_NAME" -n "dashboard"
setup_tmux_navigation

# New 4-pane layout:
# Header 90%: dashboard 80% | codex 20%
# Bottom 10%: live log 80% | helper 20%

# Split vertical first: header 90% / bottom 10%
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

tmux send-keys -t "$SESSION_NAME:0.0" "python3 '$SCRIPT_DIR/dashboard.py' '$FLOW_ID' 0.1" Enter

  # Pane 1: header-right codex cli
  tmux send-keys -t "$SESSION_NAME:0.1" "cd '$REPO_ROOT' && clear && codex" Enter

# Generate helper script from template
sed -e "s|__FLOW_ID__|$FLOW_ID|g" \
    -e "s|__WORK_DIR__|$WORK_DIR|g" \
    -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" \
    -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
    "$SCRIPT_DIR/tmux-helper-template.sh" > "$WORK_DIR/tmux-helper.sh"
chmod +x "$WORK_DIR/tmux-helper.sh"
# Pane 3: bottom-right helper
tmux send-keys -t "$SESSION_NAME:0.3" "$WORK_DIR/tmux-helper.sh" Enter

# Pane 2: bottom-left live log
LOG_DIR="$WORK_DIR/logs"
mkdir -p "$LOG_DIR"
CURRENT_LOG="$LOG_DIR/current.log"
touch "$CURRENT_LOG"
tmux send-keys -t "$SESSION_NAME:0.2" "python3 '$SCRIPT_DIR/log-pretty.py' '$CURRENT_LOG' || echo 'Waiting for agent logs...'" Enter

tmux new-window -t "$SESSION_NAME" -n "raw-files"
tmux send-keys -t "$SESSION_NAME:1.0" "cd '$WORK_DIR' && echo 'Raw output files' && ls -la && echo '' && echo 'Use: less clarify.md / architecture.md / plan.md / implementation.md / verification.md' && zsh" Enter

tmux select-window -t "$SESSION_NAME:0"
tmux select-pane -t "$SESSION_NAME:0.0"

echo "✅ Dashboard ready: $SESSION_NAME"
echo ""
echo "Controls:"
echo "  - Ctrl+B then arrow keys: navigate panes"
echo "  - Ctrl+B then d: detach"
echo "  - Ctrl+B then [: scroll mode (q to exit)"
echo ""
echo "To reattach later:"
echo "  tmux attach-session -t $SESSION_NAME"
echo ""

start_tmux_refresh_loop "$SESSION_NAME"
tmux attach-session -t "$SESSION_NAME"
