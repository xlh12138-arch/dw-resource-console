#!/bin/sh
set -eu

APP_HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$APP_HOME"
mkdir -p logs

if [ -f logs/api.pid ]; then
  OLD_PID=$(cat logs/api.pid)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "API already running: PID $OLD_PID"
    exit 0
  fi
fi

nohup node apps/api/dist/server.js > logs/api.log 2>&1 &
PID=$!
echo "$PID" > logs/api.pid

i=0
while [ "$i" -lt 30 ]; do
  if node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "API started: PID $PID"
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "API exited during startup. Last log lines:"
    tail -n 50 logs/api.log 2>/dev/null || true
    rm -f logs/api.pid
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

echo "API health check timed out. Last log lines:"
tail -n 50 logs/api.log 2>/dev/null || true
exit 1
