#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[Tracearr]${NC} $1"; }
warn() { echo -e "${YELLOW}[Tracearr]${NC} $1"; }
error() { echo -e "${RED}[Tracearr]${NC} $1"; }

# Create log directory
mkdir -p /var/log/supervisor

# =============================================================================
# Timezone configuration
# =============================================================================
if [ -n "$TZ" ] && [ "$TZ" != "UTC" ]; then
    if [ -f "/usr/share/zoneinfo/$TZ" ]; then
        ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
        echo "$TZ" > /etc/timezone
        log "Timezone set to $TZ"
    else
        warn "Invalid timezone '$TZ', using UTC"
    fi
fi

# =============================================================================
# Generate secrets if not provided
# =============================================================================
mkdir -p /data/tracearr

if [ -z "$JWT_SECRET" ]; then
    if [ -f /data/tracearr/.jwt_secret ]; then
        export JWT_SECRET=$(cat /data/tracearr/.jwt_secret)
        log "Loaded JWT_SECRET from persistent storage"
    else
        export JWT_SECRET=$(openssl rand -hex 32)
        echo "$JWT_SECRET" > /data/tracearr/.jwt_secret
        chmod 600 /data/tracearr/.jwt_secret
        log "Generated new JWT_SECRET"
    fi
fi

if [ -z "$COOKIE_SECRET" ]; then
    if [ -f /data/tracearr/.cookie_secret ]; then
        export COOKIE_SECRET=$(cat /data/tracearr/.cookie_secret)
        log "Loaded COOKIE_SECRET from persistent storage"
    else
        export COOKIE_SECRET=$(openssl rand -hex 32)
        echo "$COOKIE_SECRET" > /data/tracearr/.cookie_secret
        chmod 600 /data/tracearr/.cookie_secret
        log "Generated new COOKIE_SECRET"
    fi
fi

if [ -z "$ENCRYPTION_KEY" ]; then
    if [ -f /data/tracearr/.encryption_key ]; then
        export ENCRYPTION_KEY=$(cat /data/tracearr/.encryption_key)
        log "Loaded ENCRYPTION_KEY from persistent storage"
    else
        export ENCRYPTION_KEY=$(openssl rand -hex 32)
        echo "$ENCRYPTION_KEY" > /data/tracearr/.encryption_key
        chmod 600 /data/tracearr/.encryption_key
        log "Generated new ENCRYPTION_KEY"
    fi
fi

# =============================================================================
# Initialize PostgreSQL if needed
# =============================================================================
if [ ! -f /data/postgres/PG_VERSION ]; then
    log "Initializing PostgreSQL database..."

    # Ensure data directory exists (may not if bind mount path is new)
    mkdir -p /data/postgres

    # Handle corrupt/partial initialization (has files but no PG_VERSION)
    if [ "$(ls -A /data/postgres 2>/dev/null)" ]; then
        warn "Data directory exists but is not initialized - clearing for fresh init"
        rm -rf /data/postgres/*
    fi

    # Ensure postgres owns the data directory
    chown -R postgres:postgres /data/postgres

    # Initialize the database cluster
    gosu postgres /usr/lib/postgresql/15/bin/initdb -D /data/postgres

    # Configure PostgreSQL
    cat >> /data/postgres/postgresql.conf <<EOF
shared_preload_libraries = 'timescaledb'
listen_addresses = '127.0.0.1'
port = 5432
log_timezone = 'UTC'
timezone = 'UTC'
EOF

    # Allow local connections
    cat > /data/postgres/pg_hba.conf <<EOF
local all all trust
host all all 127.0.0.1/32 md5
EOF

    # Start PostgreSQL temporarily to create database and user
    gosu postgres /usr/lib/postgresql/15/bin/pg_ctl -D /data/postgres -w start

    log "Creating tracearr database and user..."
    gosu postgres psql -c "CREATE USER tracearr WITH PASSWORD 'tracearr';"
    gosu postgres psql -c "CREATE DATABASE tracearr OWNER tracearr;"
    gosu postgres psql -d tracearr -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
    gosu postgres psql -d tracearr -c "GRANT ALL PRIVILEGES ON DATABASE tracearr TO tracearr;"
    gosu postgres psql -d tracearr -c "GRANT ALL ON SCHEMA public TO tracearr;"

    # Stop PostgreSQL (supervisord will start it)
    gosu postgres /usr/lib/postgresql/15/bin/pg_ctl -D /data/postgres -w stop

    log "PostgreSQL initialized successfully"
else
    log "PostgreSQL data directory exists, skipping initialization"
fi

# Ensure data directories exist and have correct ownership
# This handles fresh installs, upgrades, and bind mounts to new paths
mkdir -p /data/postgres /data/redis /data/tracearr
chown -R postgres:postgres /data/postgres
chown -R redis:redis /data/redis
chown -R tracearr:tracearr /data/tracearr
chown -R tracearr:tracearr /app

# =============================================================================
# Link GeoIP database if exists
# =============================================================================
if [ -f /data/tracearr/GeoLite2-City.mmdb ]; then
    mkdir -p /app/data
    ln -sf /data/tracearr/GeoLite2-City.mmdb /app/data/GeoLite2-City.mmdb
    log "GeoIP database linked from /data/tracearr/"
elif [ -f /app/data/GeoLite2-City.mmdb ]; then
    log "Using bundled GeoIP database"
else
    warn "GeoIP database not found - geolocation features will be limited"
    warn "Place GeoLite2-City.mmdb in /data/tracearr/ for full functionality"
fi

# =============================================================================
# Start supervisord
# =============================================================================
log "Starting Tracearr services..."
log "  - PostgreSQL 15 with TimescaleDB"
log "  - Redis"
log "  - Tracearr application"
exec "$@"
