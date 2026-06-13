#!/usr/bin/env bash
# check-env.sh - Verify environment before starting dev-team workflow

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Color codes
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
DIM=$'\033[2m'
NC=$'\033[0m' # No Color

errors=0
warnings=0

print_check() {
  local status="$1"
  local message="$2"
  case "$status" in
    ok)
      printf "  ${GREEN}✓${NC} %s\n" "$message"
      ;;
    fail)
      printf "  ${RED}✗${NC} %s\n" "$message"
      errors=$((errors + 1))
      ;;
    warn)
      printf "  ${YELLOW}⚠${NC} %s\n" "$message"
      warnings=$((warnings + 1))
      ;;
  esac
}

# 1. Check Codex CLI
echo "Checking Codex CLI..."
if command -v codex &>/dev/null; then
  codex_version=$(codex --version 2>&1 | head -1 || echo "unknown")
  print_check ok "Codex CLI found: $codex_version"
else
  print_check fail "Codex CLI not found (required for implementer agent)"
fi
echo ""

# 2. Check MCP (mcporter)
echo "Checking MCP (mcporter)..."
if command -v mcporter &>/dev/null; then
  print_check ok "mcporter found"
  
  # Check configured MCP servers
  mcporter_output=$(mcporter list 2>/dev/null || true)
  server_count=$(printf '%s\n' "$mcporter_output" | grep -c '^- ' || true)
  offline_count=$(printf '%s\n' "$mcporter_output" | grep -c 'offline' || true)
  if [ "$server_count" -gt 0 ]; then
    print_check ok "MCP servers configured: $server_count"
    if [ "$offline_count" -gt 0 ]; then
      print_check warn "MCP server(s) offline: $offline_count"
    fi
  else
    print_check warn "No MCP servers configured"
  fi
else
  print_check warn "mcporter not found (optional for Bitbucket/Slack integration)"
  echo "    To install: npm install -g mcporter"
fi
echo ""

# 4. Check Node.js (for orchestrator.js, spawn-via-gateway.js, watcher.js)
echo "Checking Node.js..."
if command -v node &>/dev/null; then
  node_version=$(node --version)
  print_check ok "Node.js found: $node_version"
else
  print_check fail "Node.js not found (required for orchestrator)"
fi
echo ""

# 5. Check Python3 (for dashboard, log-pretty)
echo "Checking Python3..."
if command -v python3 &>/dev/null; then
  python_version=$(python3 --version)
  print_check ok "Python3 found: $python_version"
else
  print_check fail "Python3 not found (required for dashboard)"
fi
echo ""

# 6. Check tmux (for start-with-monitor.sh)
echo "Checking tmux..."
if command -v tmux &>/dev/null; then
  tmux_version=$(tmux -V)
  print_check ok "tmux found: $tmux_version"
else
  print_check warn "tmux not found (monitoring dashboard will not work)"
fi
echo ""

# 7. Check git
echo "Checking git..."
if command -v git &>/dev/null; then
  git_version=$(git --version)
  print_check ok "git found: $git_version"
else
  print_check fail "git not found (required)"
fi
echo ""

# 10. Check project Docker containers
echo "Checking project Docker containers..."
required_containers=(
  "hr_nginx"
  "hr_jinji"
  "hr_auth"
  "hr_core"
  "hr_auth_core"
  "jinjer_mysql"
  "jinjer_mysql_test"
  "redis"
)

if command -v docker &>/dev/null && docker info &>/dev/null; then
  missing_containers=()
  stopped_containers=()
  running_containers=()
  
  for container in "${required_containers[@]}"; do
    state=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo "missing")
    case "$state" in
      running)
        uptime=$(docker inspect -f '{{.State.StartedAt}}' "$container" 2>/dev/null | xargs -I{} date -d {} +%s 2>/dev/null || echo "0")
        now=$(date +%s)
        elapsed=$((now - uptime))
        if [ $elapsed -gt 86400 ]; then
          uptime_str="$((elapsed / 86400))d"
        elif [ $elapsed -gt 3600 ]; then
          uptime_str="$((elapsed / 3600))h"
        elif [ $elapsed -gt 60 ]; then
          uptime_str="$((elapsed / 60))m"
        else
          uptime_str="${elapsed}s"
        fi
        running_containers+=("$container:$uptime_str")
        ;;
      missing)
        missing_containers+=("$container")
        ;;
      *)
        stopped_containers+=("$container:$state")
        ;;
    esac
  done

  if [ ${#missing_containers[@]} -eq 0 ] && [ ${#stopped_containers[@]} -eq 0 ]; then
    print_check ok "All project containers are running (${#required_containers[@]})"
    echo ""
    
    # Calculate max widths
    max_name_len=9  # "Container"
    max_uptime_len=6  # "Uptime"
    for item in "${running_containers[@]}"; do
      name="${item%%:*}"
      uptime="${item##*:}"
      [ ${#name} -gt $max_name_len ] && max_name_len=${#name}
      [ ${#uptime} -gt $max_uptime_len ] && max_uptime_len=${#uptime}
    done
    
    name_width=$((max_name_len + 2))
    status_width=10  # "running" + padding
    uptime_width=$((max_uptime_len + 2))
    
    # Print table header
    printf "  ┌"
    printf '%0.s─' $(seq 1 $name_width)
    printf "┬"
    printf '%0.s─' $(seq 1 $status_width)
    printf "┬"
    printf '%0.s─' $(seq 1 $uptime_width)
    printf "┐\n"
    
    printf "  │ %-${max_name_len}s │ %-8s │ %-${max_uptime_len}s │\n" "Container" "Status" "Uptime"
    
    printf "  ├"
    printf '%0.s─' $(seq 1 $name_width)
    printf "┼"
    printf '%0.s─' $(seq 1 $status_width)
    printf "┼"
    printf '%0.s─' $(seq 1 $uptime_width)
    printf "┤\n"
    
    # Print rows
    for item in "${running_containers[@]}"; do
      name="${item%%:*}"
      uptime="${item##*:}"
      printf "  │ %-${max_name_len}s │ %-8s │ %-${max_uptime_len}s │\n" "$name" "running" "$uptime"
    done
    
    printf "  └"
    printf '%0.s─' $(seq 1 $name_width)
    printf "┴"
    printf '%0.s─' $(seq 1 $status_width)
    printf "┴"
    printf '%0.s─' $(seq 1 $uptime_width)
    printf "┘\n"
  else
    for container in "${missing_containers[@]}"; do
      print_check fail "Container missing: $container"
    done
    for item in "${stopped_containers[@]}"; do
      print_check fail "Container not running: $item"
    done
  fi
else
  print_check fail "Cannot check containers because Docker is unavailable"
fi
echo ""

# 11. Check Bitbucket MCP server
echo "Checking Bitbucket MCP server..."
bitbucket_mcp="$REPO_ROOT/.dev-team/agents/bitbucket"
if [ -d "$bitbucket_mcp" ]; then
  if [ -f "$bitbucket_mcp/.env" ]; then
    print_check ok "Bitbucket MCP server found with .env"
  else
    print_check warn "Bitbucket MCP server found but missing .env"
  fi
else
  print_check warn "Bitbucket MCP server not found (optional)"
fi
echo ""

# 12. Check team.json
echo "Checking team.json..."
team_config="$REPO_ROOT/.dev-team/team.json"
if [ -f "$team_config" ]; then
  if jq empty "$team_config" &>/dev/null; then
    print_check ok "team.json found and valid JSON"
  else
    print_check fail "team.json found but invalid JSON"
  fi
else
  print_check fail "team.json not found at $team_config"
fi
echo ""

# Summary
if [ $errors -eq 0 ]; then
  if [ $warnings -eq 0 ]; then
    printf "${GREEN}✓ All checks passed!${NC}\n"
  else
    printf "${YELLOW}⚠ %s warning(s) found, but core requirements met.${NC}\n" "$warnings"
  fi
  echo ""
  exit 0
else
  printf "${RED}✗ %s error(s) found. Please fix before running dev-team workflow.${NC}\n" "$errors"
  if [ $warnings -gt 0 ]; then
    printf "${YELLOW}⚠ %s warning(s) found as well.${NC}\n" "$warnings"
  fi
  echo ""
  exit 1
fi
