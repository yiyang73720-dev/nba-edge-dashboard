#!/bin/bash
# Start Alpha Hunter signal engine in the background
# Usage: ./start-engine.sh [both|nba|ncaab]
# Default: both (scans NBA + NCAAB simultaneously)

MODE=${1:-both}
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/engine.log"
PID_FILE="$DIR/engine.pid"

# Kill existing engine if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing engine (PID $OLD_PID)..."
    kill "$OLD_PID"
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

echo "Starting Alpha Hunter engine ($MODE mode)..."
echo "Log: $LOG"

nohup node "$DIR/signal-engine.js" "$MODE" >> "$LOG" 2>&1 &
echo $! > "$PID_FILE"
echo "Engine running (PID $(cat "$PID_FILE"))"
echo "Signals will be saved to: $DIR/engine-signals.json"
echo ""
echo "Web UI: http://localhost:3000"
echo "To stop:  ./stop-engine.sh"
echo "To view:  tail -f $LOG"
