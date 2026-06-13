#!/usr/bin/env bash
# check-status.sh - Check dashboard and tunnel status

set -euo pipefail

echo "🔍 DevTeam Dashboard Status Check"
echo "================================="
echo ""

# Check Dashboard Server
echo "📊 Dashboard Server:"
if curl -s http://localhost:3001 > /dev/null 2>&1; then
    echo "   ✅ Running on http://localhost:3001"

    # Get API status
    FLOWS=$(curl -s http://localhost:3001/api/flows | jq -r '.flows | length' 2>/dev/null || echo "unknown")
    echo "   📈 Active flows: $FLOWS"
else
    echo "   ❌ Not running"
fi
echo ""

# Check Cloudflare Tunnel
echo "🌐 Cloudflare Tunnel:"
TUNNEL_PIDS=$(pgrep -f cloudflared || true)
if [ -n "$TUNNEL_PIDS" ]; then
    echo "   ✅ Running (PID: $TUNNEL_PIDS)"

    # Try to detect tunnel URL from process
    for PID in $TUNNEL_PIDS; do
        CMDLINE=$(ps -p $PID -o args= || true)
        if echo "$CMDLINE" | grep -q "localhost:3001"; then
            echo "   🔗 Exposing: localhost:3001"
        fi
    done
else
    echo "   ❌ Not running"
fi
echo ""

# Check tmux sessions
echo "📺 tmux Sessions:"
if command -v tmux &> /dev/null; then
    SESSIONS=$(tmux list-sessions 2>/dev/null | grep -E "devteam|dashboard|tunnel" || true)
    if [ -n "$SESSIONS" ]; then
        echo "$SESSIONS"
    else
        echo "   No related sessions found"
    fi
else
    echo "   tmux not installed"
fi
echo ""

# Check ports
echo "🔌 Port Usage:"
if command -v lsof &> /dev/null; then
    PORT_3001=$(lsof -i :3001 -P -n | grep LISTEN || echo "   Port 3001: Free")
    PORT_5173=$(lsof -i :5173 -P -n | grep LISTEN || echo "   Port 5173: Free")

    if [ -n "$PORT_3001" ]; then
        echo "   Port 3001: $PORT_3001"
    else
        echo "   Port 3001: Free"
    fi

    if [ -n "$PORT_5173" ]; then
        echo "   Port 5173: $PORT_5173"
    else
        echo "   Port 5173: Free"
    fi
else
    echo "   lsof not available"
fi
echo ""

# Summary
echo "📋 Quick Actions:"
echo "   Start dashboard:     npm run dev"
echo "   Start quick tunnel:  ./cloudflare-tunnel-quick.sh"
echo "   Start both:          ./start-with-tunnel.sh"
echo "   Stop tunnel:         ./stop-tunnel.sh"
echo ""
