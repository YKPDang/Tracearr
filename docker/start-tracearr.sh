#!/bin/bash
# Wrapper script for starting Tracearr after dependencies are ready
# Used by supervisord to ensure PostgreSQL and Redis are available

set -e

MAX_RETRIES=30
RETRY_INTERVAL=2

# Wait for PostgreSQL
echo "[Tracearr] Waiting for PostgreSQL..."
for i in $(seq 1 $MAX_RETRIES); do
    if pg_isready -h 127.0.0.1 -p 5432 -U tracearr -q; then
        echo "[Tracearr] PostgreSQL is ready"
        break
    fi
    if [ $i -eq $MAX_RETRIES ]; then
        echo "[Tracearr] ERROR: PostgreSQL failed to become ready after $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
        exit 1
    fi
    sleep $RETRY_INTERVAL
done

# Wait for Redis
echo "[Tracearr] Waiting for Redis..."
for i in $(seq 1 $MAX_RETRIES); do
    if redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; then
        echo "[Tracearr] Redis is ready"
        break
    fi
    if [ $i -eq $MAX_RETRIES ]; then
        echo "[Tracearr] ERROR: Redis failed to become ready after $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
        exit 1
    fi
    sleep $RETRY_INTERVAL
done

echo "[Tracearr] Starting application..."
exec node /app/apps/server/dist/index.js
