#!/usr/bin/env bash
# ============================================================================
# setup.sh — DevTeam Agent Orchestrator Setup Script
# ============================================================================
# This script automates the complete setup process for the DevTeam Agent
# Orchestrator development environment.
#
# Usage:
#   ./setup.sh          # Full setup (interactive)
#   ./setup.sh --check  # Only check prerequisites
#   ./setup.sh --start  # Start services after setup
# ============================================================================

set -euo pipefail

# ============================================================================
# Constants
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$SCRIPT_DIR/dashboard"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
DB_FILE="$SCRIPT_DIR/workflows.db"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ============================================================================
# Helper Functions
# ============================================================================
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

check_command() {
  if command -v "$1" &> /dev/null; then
    local version
    version=$("$1" --version 2>/dev/null | head -1 || echo "unknown")
    log_success "$1 found: $version"
    return 0
  else
    log_error "$1 not found"
    return 1
  fi
}

prompt_yn() {
  local prompt="$1"
  local default="${2:-y}"
  local yn
  if [[ "$default" == "y" ]]; then
    read -rp "$(echo -e "${YELLOW}$prompt [Y/n]:${NC} ")" yn
    yn="${yn:-y}"
  else
    read -rp "$(echo -e "${YELLOW}$prompt [y/N]:${NC} ")" yn
    yn="${yn:-n}"
  fi
  [[ "$yn" =~ ^[Yy]$ ]]
}

# ============================================================================
# Check Functions
# ============================================================================
check_os() {
  log_step "Checking Operating System"
  
  local os
  os="$(uname -s)"
  log_info "OS: $os"
  
  case "$os" in
    Linux*)
      log_info "Platform: Linux"
      if [ -f /etc/os-release ]; then
        . /etc/os-release
        log_info "Distribution: $NAME $VERSION_ID"
      fi
      ;;
    Darwin*)
      log_info "Platform: macOS"
      ;;
    *)
      log_warn "Unsupported OS: $os (may work but untested)"
      ;;
  esac
}

check_node() {
  log_step "Checking Node.js"
  
  if ! check_command node; then
    log_error "Node.js is required (>= 22.15.0)"
    log_info "Install via: https://nodejs.org/"
    log_info "Or use nvm: nvm install 22 && nvm use 22"
    return 1
  fi
  
  local node_version
  node_version=$(node -v | sed 's/v//')
  local required="22.15.0"
  
  if [ "$(printf '%s\n' "$required" "$node_version" | sort -V | head -1)" != "$required" ]; then
    log_error "Node.js $node_version found, but >= $required is required"
    return 1
  fi
  log_success "Node.js version: $node_version"
  
  if ! check_command npm; then
    log_error "npm is required"
    return 1
  fi
}

check_docker() {
  log_step "Checking Docker"
  
  if ! check_command docker; then
    log_warn "Docker not found (required for Inngest)"
    log_info "Install via: https://docs.docker.com/get-docker/"
    if prompt_yn "Continue without Docker? (Inngest won't work)" "n"; then
      return 0
    fi
    return 1
  fi
  
  if ! docker info &> /dev/null; then
    log_warn "Docker daemon is not running"
    log_info "Start Docker and try again"
    return 1
  fi
  log_success "Docker daemon is running"
  
  if ! check_command docker-compose && ! docker compose version &> /dev/null; then
    log_warn "docker-compose not found"
    return 1
  fi
  log_success "Docker Compose available"
}

check_codex() {
  log_step "Checking Codex CLI"
  
  if ! check_command codex; then
    log_warn "Codex CLI not found (required for appserver runtime)"
    log_info "Install via: npm i -g @openai/codex"
    if prompt_yn "Continue without Codex CLI?" "n"; then
      return 0
    fi
    return 1
  fi
}

check_git() {
  log_step "Checking Git"
  
  if ! check_command git; then
    log_error "Git is required"
    return 1
  fi
}

check_uv() {
  log_step "Checking uv (Python package manager)"
  
  if check_command uv; then
    log_success "uv available for MCP servers"
  else
    log_warn "uv not found (optional, for git MCP server)"
    log_info "Install via: curl -LsSf https://astral.sh/uv/install.sh | sh"
  fi
}

# ============================================================================
# Setup Functions
# ============================================================================
setup_env() {
  log_step "Setting up Environment Variables"
  
  if [ -f "$ENV_FILE" ]; then
    log_info ".env file already exists"
    if prompt_yn "Overwrite existing .env?" "n"; then
      cp "$ENV_EXAMPLE" "$ENV_FILE"
      log_success "Copied .env.example to .env"
    else
      log_info "Keeping existing .env"
      return 0
    fi
  else
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    log_success "Copied .env.example to .env"
  fi
  
  # Generate random keys if using defaults
  if grep -q "replace_with_a_random_hex_value" "$ENV_FILE"; then
    log_info "Generating random keys for Inngest..."
    local event_key signing_key
    event_key=$(openssl rand -hex 32)
    signing_key=$(openssl rand -hex 32)
    
    sed -i "s/INNGEST_EVENT_KEY=replace_with_a_random_hex_value/INNGEST_EVENT_KEY=$event_key/" "$ENV_FILE"
    sed -i "s/INNGEST_SIGNING_KEY=replace_with_a_random_hex_value/INNGEST_SIGNING_KEY=$signing_key/" "$ENV_FILE"
    log_success "Generated Inngest keys"
  fi
  
  # Prompt for appserver URL
  if ! grep -q "CODEX_APP_SERVER_URL" "$ENV_FILE" || grep -q "^# CODEX_APP_SERVER_URL" "$ENV_FILE"; then
    if prompt_yn "Enable app-server runtime?" "y"; then
      local port="${CODEX_APP_SERVER_PORT:-9876}"
      sed -i "s|# CODEX_APP_SERVER_URL=.*|CODEX_APP_SERVER_URL=ws://127.0.0.1:$port|" "$ENV_FILE"
      sed -i "s|# DASHBOARD_APP_SERVER_AUTO_APPROVE=.*|DASHBOARD_APP_SERVER_AUTO_APPROVE=true|" "$ENV_FILE"
      log_success "Enabled app-server runtime on port $port"
    fi
  fi
  
  log_info "Current .env configuration:"
  grep -v "^#" "$ENV_FILE" | grep -v "^$" | sed 's/=.*/=***/' | head -10
}

setup_dependencies() {
  log_step "Installing Dependencies"
  
  # Dashboard dependencies
  log_info "Installing dashboard dependencies..."
  cd "$DASHBOARD_DIR"
  npm install
  log_success "Dashboard dependencies installed"
  
  # MCP dependencies (optional)
  if [ -d "$SCRIPT_DIR/mcp" ]; then
    log_info "Installing MCP dependencies..."
    cd "$SCRIPT_DIR/mcp"
    npm install 2>/dev/null || log_warn "MCP install failed (non-critical)"
    log_success "MCP dependencies installed"
  fi
  
  # Agent dependencies (optional)
  for agent_dir in "$SCRIPT_DIR/agents"/*/; do
    if [ -f "$agent_dir/package.json" ]; then
      local agent_name
      agent_name=$(basename "$agent_dir")
      log_info "Installing $agent_name agent dependencies..."
      cd "$agent_dir"
      npm install 2>/dev/null || log_warn "$agent_name install failed (non-critical)"
    fi
  done
  
  cd "$SCRIPT_DIR"
}

setup_build() {
  log_step "Building TypeScript"
  
  cd "$DASHBOARD_DIR"
  npm run build
  log_success "TypeScript build completed"
  cd "$SCRIPT_DIR"
}

setup_database() {
  log_step "Initializing Database"
  
  if [ -f "$DB_FILE" ]; then
    log_info "Database already exists: $DB_FILE"
  else
    log_info "Database will be created on first run"
  fi
}

setup_codex_config() {
  log_step "Checking Codex Configuration"
  
  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local config_file="$codex_home/config.toml"
  
  if [ ! -d "$codex_home" ]; then
    log_info "Codex home directory not found at $codex_home"
    log_info "Codex will create it on first run"
    return 0
  fi
  
  if [ -f "$config_file" ]; then
    log_success "Codex config found: $config_file"
  else
    log_warn "No Codex config found"
    log_info "Create $config_file with your MCP server configurations"
  fi
  
  # Check for workspace trust
  local workspace_path
  workspace_path="$(dirname "$SCRIPT_DIR")"
  if grep -q "\\[\"$workspace_path\"\\]" "$config_file" 2>/dev/null; then
    log_success "Workspace is trusted in Codex config"
  else
    log_warn "Workspace not trusted in Codex config"
    log_info "Add to $config_file:"
    log_info "  [\"$workspace_path\"]"
    log_info "  trust_level = \"trusted\""
  fi
}

# ============================================================================
# Start Functions
# ============================================================================
start_inngest() {
  log_step "Starting Inngest"
  
  cd "$SCRIPT_DIR"
  
  # Check if already running
  if curl -s http://127.0.0.1:8288/health > /dev/null 2>&1; then
    log_success "Inngest already running at http://127.0.0.1:8288"
    return 0
  fi
  
  log_info "Starting Inngest via Docker Compose..."
  docker compose -f docker-compose.inngest.yml up -d
  
  # Wait for Inngest to be ready
  log_info "Waiting for Inngest to be ready..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if curl -s http://127.0.0.1:8288/health > /dev/null 2>&1; then
      log_success "Inngest is ready"
      return 0
    fi
    sleep 1
    retries=$((retries - 1))
  done
  
  log_error "Inngest failed to start"
  return 1
}

start_docker_compose() {
  log_step "Starting Docker Compose Environment"
  
  cd "$SCRIPT_DIR"
  
  # Check if .env exists
  if [ ! -f "$ENV_FILE" ]; then
    log_error ".env file not found. Run setup first."
    return 1
  fi
  
  # Set WORKSPACE_PATH if not set
  if [ -z "${WORKSPACE_PATH:-}" ]; then
    export WORKSPACE_PATH="$(dirname "$SCRIPT_DIR")"
    log_info "WORKSPACE_PATH not set, using: $WORKSPACE_PATH"
  fi
  
  # Set CODEX_HOME if not set
  if [ -z "${CODEX_HOME:-}" ]; then
    export CODEX_HOME="$HOME/.codex"
    log_info "CODEX_HOME not set, using: $CODEX_HOME"
  fi
  
  log_info "Starting all services via Docker Compose..."
  log_info "  - Inngest (port 8288, 8289)"
  log_info "  - App Server (port 9876)"
  log_info "  - API Server (port 3001)"
  log_info "  - Client (port 5173)"
  log_info "  - Worker"
  log_info ""
  log_info "Press Ctrl+C to stop all services"
  log_info ""
  
  docker compose up --build
}

start_dev() {
  log_step "Starting Development Environment"
  
  cd "$DASHBOARD_DIR"
  
  # Load environment
  set -a
  source "$ENV_FILE"
  set +a
  
  log_info "Starting all services..."
  log_info "  - App Server (port ${CODEX_APP_SERVER_PORT:-9876})"
  log_info "  - API Server (port 3001)"
  log_info "  - Client (port 5173)"
  log_info "  - Inngest (port 8288)"
  log_info "  - Worker"
  log_info ""
  log_info "Press Ctrl+C to stop all services"
  log_info ""
  
  npm run dev
}

start_production() {
  log_step "Starting Production Mode"
  
  cd "$DASHBOARD_DIR"
  
  # Load environment
  set -a
  source "$ENV_FILE"
  set +a
  
  # Build if needed
  if [ ! -d "client/dist" ] || [ ! -d "server/dist" ]; then
    log_info "Building for production..."
    npm run build
  fi
  
  log_info "Starting production server..."
  npm run start
}

# ============================================================================
# Main Script
# ============================================================================
main() {
  echo -e "${CYAN}"
  echo "╔═══════════════════════════════════════════════════════════════╗"
  echo "║       DevTeam Agent Orchestrator - Setup Script              ║"
  echo "╚═══════════════════════════════════════════════════════════════╝"
  echo -e "${NC}"
  
  local mode="${1:-}"
  
  case "$mode" in
    --check)
      check_os
      check_node
      check_docker
      check_codex
      check_git
      check_uv
      log_success "All checks completed"
      exit 0
      ;;
    --start)
      start_inngest
      start_dev
      exit 0
      ;;
    --docker)
      start_docker_compose
      exit 0
      ;;
    --prod)
      start_inngest
      start_production
      exit 0
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  (none)      Full interactive setup"
      echo "  --check     Only check prerequisites"
      echo "  --start     Start services (assumes setup done)"
      echo "  --docker    Start all services via Docker Compose"
      echo "  --prod      Start in production mode"
      echo "  --help      Show this help"
      echo ""
      exit 0
      ;;
  esac
  
  # Full interactive setup
  log_step "Step 1: Checking Prerequisites"
  
  local errors=0
  check_os || ((errors++))
  check_node || ((errors++))
  check_git || ((errors++))
  check_docker || true  # Docker is optional
  check_codex || true   # Codex is optional
  check_uv || true      # uv is optional
  
  if [ $errors -gt 0 ]; then
    log_error "Some required prerequisites are missing"
    log_info "Please install them and run this script again"
    exit 1
  fi
  
  log_step "Step 2: Environment Setup"
  setup_env
  
  log_step "Step 3: Install Dependencies"
  if prompt_yn "Install npm dependencies?" "y"; then
    setup_dependencies
  fi
  
  log_step "Step 4: Build TypeScript"
  if prompt_yn "Build TypeScript projects?" "y"; then
    setup_build
  fi
  
  log_step "Step 5: Database Setup"
  setup_database
  
  log_step "Step 6: Codex Configuration"
  setup_codex_config
  
  # Summary
  echo ""
  echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║                    Setup Complete!                            ║${NC}"
  echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "To start the development environment:"
  echo "  ./setup.sh --start"
  echo ""
  echo "Or manually:"
  echo "  cd dashboard && npm run dev"
  echo ""
  echo "Services:"
  echo "  - Dashboard:  http://localhost:5173"
  echo "  - API Server: http://localhost:3001"
  echo "  - Inngest:    http://localhost:8288"
  echo "  - App Server: ws://127.0.0.1:9876"
  echo ""
  
  if prompt_yn "Start development environment now?" "y"; then
    start_inngest
    start_dev
  fi
}

# Run main function
main "$@"
