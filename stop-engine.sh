#!/bin/bash
# Stop Alpha Hunter signal engine
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/engine.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "Engine stopped (PID $PID)"
  else
    echo "Engine not running (stale PID file)"
  fi
  rm -f "$PID_FILE"
else
  echo "No engine running (no PID file)"
fi
