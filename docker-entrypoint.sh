#!/bin/sh
set -u

WORKER_PID=""
API_PID=""

cleanup() {
  if [ -n "$WORKER_PID" ]; then
    kill "$WORKER_PID" 2>/dev/null || true
  fi
  if [ -n "$API_PID" ]; then
    kill "$API_PID" 2>/dev/null || true
  fi
  if [ -n "$WORKER_PID" ]; then
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  if [ -n "$API_PID" ]; then
    wait "$API_PID" 2>/dev/null || true
  fi
}

on_signal() {
  cleanup
  exit 0
}

trap on_signal TERM INT

npm run worker &
WORKER_PID=$!
npm run start &
API_PID=$!

while kill -0 "$WORKER_PID" 2>/dev/null && kill -0 "$API_PID" 2>/dev/null; do
  sleep 5
done

echo "[entrypoint] one process exited; stopping the other" >&2
cleanup
exit 1
