#!/bin/bash
set -e

# Start the openclaw gateway in the background
echo "[e2e] Starting OpenClaw gateway..."
openclaw gateway run --allow-unconfigured &
GATEWAY_PID=$!

# Wait for gateway to be ready
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:18789/v1/models >/dev/null 2>&1; then
    echo "[e2e] Gateway is ready (PID $GATEWAY_PID)"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[e2e] WARNING: Gateway didn't respond after 30s, continuing anyway"
  fi
  sleep 1
done

# Run whatever command was passed (default: bash)
exec "$@"
