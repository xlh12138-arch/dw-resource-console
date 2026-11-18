#!/bin/sh
set -eu

APP_HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$APP_HOME"

if [ ! -f logs/api.pid ]; then
  echo "API PID file not found"
  exit 0
fi

PID=$(cat logs/api.pid)
if ! kill -0 "$PID" 2>/dev/null; then
  echo "API process not running: PID $PID"
  rm -f logs/api.pid
  exit 0
fi

kill "$PID"
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 15 ]; do
  i=$((i + 1))
  sleep 1
done

if kill -0 "$PID" 2>/dev/null; then
  kill -9 "$PID"
  echo "API force stopped: PID $PID"
else
  echo "API stopped: PID $PID"
fi
rm -f logs/api.pid
