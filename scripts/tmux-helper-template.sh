#!/usr/bin/env bash
# tmux-helper-template.sh — single source of truth for retry helper
# Placeholders filled by start-with-monitor.sh via sed:
#   __FLOW_ID__, __WORK_DIR__, __SCRIPT_DIR__, __REPO_ROOT__
set -euo pipefail

WORK_DIR="__WORK_DIR__"
FLOW_ID="__FLOW_ID__"
SCRIPT_DIR="__SCRIPT_DIR__"
REPO_ROOT="__REPO_ROOT__"

# Map step name to output file
get_output_file() {
  local step="$1"
  case "$step" in
    clarifier) echo "$WORK_DIR/output/clarify.md" ;;
    architect) echo "$WORK_DIR/output/architecture.md" ;;
    planner) echo "$WORK_DIR/output/plan.md" ;;
    implementer) echo "$WORK_DIR/output/implementation.md" ;;
    verifier) echo "$WORK_DIR/output/verification.md" ;;
    *) echo "" ;;
  esac
}

retry_step() {
  local step="$1"
  local mode="$2"   # 'r' or 'R'

  # Validate step
  case "$step" in
    clarifier|architect|planner|implementer|verifier) ;;
    *) echo "Invalid step: $step"; sleep 2; return ;;
  esac

  local output_file
  output_file="$(get_output_file "$step")"

  # Property 4: 'r' warns when output exists and asks user
  if [[ "$mode" == "r" && -f "$output_file" ]]; then
    echo ""
    echo "⚠️  Output đã tồn tại: $(basename "$output_file")"
    echo ""
    echo "  1) Backup rồi retry (giữ file cũ → .bak)"
    echo "  2) Clear rồi retry (xóa file cũ)"
    echo "  3) Cancel"
    echo ""
    read -n1 -p "Chọn [1-3]: " output_choice
    echo ""
    case "$output_choice" in
      1)
        cp "$output_file" "${output_file}.bak-$(date +%Y%m%d%H%M%S)"
        echo "📦 Backed up → $(basename "${output_file}").bak-..."
        clear_output="true"
        ;;
      2)
        clear_output="true"
        ;;
      *)
        echo "Cancelled."
        read -rp "Enter to continue..."
        return
        ;;
    esac
  fi

  # Determine clearOutput flag
  local clear_output="false"
  if [[ "$mode" == "R" ]]; then
    clear_output="true"
  fi

  # Reset workflow state via shared lib
  node -e "require('$SCRIPT_DIR/lib/retry-flow').prepareRetry('$FLOW_ID', '$step', { clearOutput: $clear_output, source: 'manual' })"

  # Ensure watcher is running
  if ! pgrep -f "watcher.js $FLOW_ID" >/dev/null 2>&1; then
    echo "🔄 Watcher not running, starting it now..."
    mkdir -p "$WORK_DIR/logs"
    nohup node "$SCRIPT_DIR/watcher.js" "$FLOW_ID" > "$WORK_DIR/logs/watcher.log" 2>&1 &
    echo "✅ Watcher started"
  fi

  # Spawn agent via canonical path
  node "$SCRIPT_DIR/spawn-via-gateway.js" "$FLOW_ID" "$step"
  read -rp "Enter to continue..."
}

while true; do
  clear
  echo "  Dev Team Helper - $FLOW_ID"
  echo ""
  echo "  [v] View step output (clarify/architecture/plan/implementation/verification)"
  echo "  [r] Retry step (requires no existing output)"
  echo "  [R] Retry + clear output file first"
  echo "  [s] Show workflow.json status"
  echo "  [g] Git status"
  echo "  [l] List all output files"
  echo "  [1-5] Switch live log: clarifier/architect/planner/implementer/verifier"
  echo "  [x] Stop workflow (kill agents, watcher, dashboard & exit)"
  echo "  [q] Quit helper"
  echo ""
  read -n1 -p "Choose: " choice
  echo ""
  case "$choice" in
    v)
      echo ""
      echo "  1) clarify.md        (Clarifier)"
      echo "  2) architecture.md   (Architect)"
      echo "  3) plan.md           (Planner)"
      echo "  4) implementation.md (Implementer)"
      echo "  5) verification.md   (Verifier)"
      echo ""
      read -n1 -p "View [1-5]: " view_choice
      echo ""
      case "$view_choice" in
        1) local_file="$WORK_DIR/output/clarify.md" ;;
        2) local_file="$WORK_DIR/output/architecture.md" ;;
        3) local_file="$WORK_DIR/output/plan.md" ;;
        4) local_file="$WORK_DIR/output/implementation.md" ;;
        5) local_file="$WORK_DIR/output/verification.md" ;;
        *) echo "Invalid"; sleep 1; continue ;;
      esac
      if [[ -f "$local_file" ]]; then
        less "$local_file"
      else
        echo "File not found: $local_file"
        read -rp "Enter to continue..."
      fi
      ;;
    r|R)
      echo ""
      echo "  1) clarifier      2) architect"
      echo "  3) planner        4) implementer"
      echo "  5) verifier"
      echo ""
      read -n1 -p "Retry step [1-5]: " retry_choice
      echo ""
      case "$retry_choice" in
        1) step_name="clarifier" ;;
        2) step_name="architect" ;;
        3) step_name="planner" ;;
        4) step_name="implementer" ;;
        5) step_name="verifier" ;;
        *) echo "Invalid"; sleep 1; continue ;;
      esac
      retry_step "$step_name" "$choice"
      ;;
    s)
      cat "$WORK_DIR/workflow.json" | python3 -m json.tool 2>/dev/null || cat "$WORK_DIR/workflow.json"
      read -rp "Enter to continue..."
      ;;
    g)
      git -C "$REPO_ROOT" status
      read -rp "Enter to continue..."
      ;;
    l)
      ls -lh "$WORK_DIR/output/"*.md 2>/dev/null || echo "No output files yet"
      read -rp "Enter to continue..."
      ;;
    1|2|3|4|5)
      mkdir -p "$WORK_DIR/logs"
      case "$choice" in
        1) agent="clarifier" ;;
        2) agent="architect" ;;
        3) agent="planner" ;;
        4) agent="implementer" ;;
        5) agent="verifier" ;;
      esac
      touch "$WORK_DIR/logs/${agent}.log"
      ln -sfn "${agent}.log" "$WORK_DIR/logs/current.log"
      echo "Switched live log to: $agent"
      sleep 1
      ;;
    q) exit 0 ;;
    x)
      echo ""
      echo "⚠️  Dừng toàn bộ workflow: $FLOW_ID"
      echo ""
      read -n1 -p "Xác nhận stop? [y/N]: " stop_confirm
      echo ""
      if [[ "$stop_confirm" == "y" || "$stop_confirm" == "Y" ]]; then
        echo "🛑 Stopping workflow..."
        node "$SCRIPT_DIR/orchestrator.js" stop "$FLOW_ID"

        # Extra cleanup: kill any lingering agent CLI processes for this flow
        echo "🧹 Cleaning up remaining processes..."
        for pattern in "kiro-cli" "codex" "claude"; do
          pids=$(pgrep -f "${pattern}.*" 2>/dev/null | grep -v "$$" || true)
          if [ -n "$pids" ]; then
            # Only kill processes whose parent is a wrapper for this flow
            for pid in $pids; do
              # Check if this process's cmdline or environment relates to this flow
              if grep -q "$FLOW_ID" /proc/$pid/cmdline 2>/dev/null || \
                 grep -q "$WORK_DIR" /proc/$pid/cmdline 2>/dev/null; then
                kill -TERM "$pid" 2>/dev/null && echo "   💀 Killed orphan $pattern (PID $pid)"
              fi
            done
          fi
        done

        # Kill any tee processes attached to our log files
        for pid in $(pgrep -f "tee.*${FLOW_ID}" 2>/dev/null || true); do
          kill -TERM "$pid" 2>/dev/null && echo "   💀 Killed tee (PID $pid)"
        done

        echo ""
        echo "Đang tắt tmux session..."
        sleep 2
        # Kill the tmux session containing this workflow
        SESSION_NAME="devteam_${FLOW_ID}"
        if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
          tmux kill-session -t "$SESSION_NAME"
        else
          # If running inside an existing session (not a dedicated one), just exit
          exit 0
        fi
      else
        echo "Cancelled."
        read -rp "Enter to continue..."
      fi
      ;;
    *) echo "Invalid"; sleep 1 ;;
  esac
done
