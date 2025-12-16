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

# ENCRYPTION_KEY is optional - only needed for migrating existing encrypted tokens
# Load existing key if present (for backward compatibility), but don't generate new ones
if [ -z "$ENCRYPTION_KEY" ] && [ -f /data/tracearr/.encryption_key ]; then
    export ENCRYPTION_KEY=$(cat /data/tracearr/.encryption_key)
    log "Loaded ENCRYPTION_KEY from persistent storage (for token migration)"
fi

# =============================================================================
# Initialize PostgreSQL if needed
# =============================================================================
init_postgres_db() {
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
    gosu postgres psql -c "CREATE USER tracearr WITH PASSWORD 'tracearr';" 2>/dev/null || true
    gosu postgres psql -c "CREATE DATABASE tracearr OWNER tracearr;" 2>/dev/null || true
    gosu postgres psql -d tracearr -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
    gosu postgres psql -d tracearr -c "CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;"
    gosu postgres psql -d tracearr -c "GRANT ALL PRIVILEGES ON DATABASE tracearr TO tracearr;"
    gosu postgres psql -d tracearr -c "GRANT ALL ON SCHEMA public TO tracearr;"

    # Stop PostgreSQL (supervisord will start it)
    gosu postgres /usr/lib/postgresql/15/bin/pg_ctl -D /data/postgres -w stop

    log "PostgreSQL initialized successfully"
}

if [ ! -f /data/postgres/PG_VERSION ]; then
    log "Initializing PostgreSQL database..."

    # Ensure data directory exists (may not if bind mount path is new)
    mkdir -p /data/postgres

    # Check if this looks like an existing installation (secrets exist)
    # If secrets exist but postgres is empty, volumes may have been disconnected
    EXISTING_INSTALL=false
    if [ -f /data/tracearr/.jwt_secret ] || [ -f /data/tracearr/.cookie_secret ]; then
        EXISTING_INSTALL=true
    fi

    # Handle corrupt/partial initialization (has files but no PG_VERSION)
    if [ "$(ls -A /data/postgres 2>/dev/null)" ]; then
        # Check if this looks like a real database (has pg_control)
        if [ -f /data/postgres/global/pg_control ]; then
            # Database files exist but PG_VERSION is missing - try to recover
            warn "PG_VERSION missing but database files exist - attempting recovery"
            warn "This can happen after filesystem issues or interrupted shutdowns"
            echo "15" > /data/postgres/PG_VERSION
            chown postgres:postgres /data/postgres/PG_VERSION
            log "Created PG_VERSION file, will attempt to start existing database"
        else
            # No pg_control - could be corrupt or volume mount issue
            if [ "$EXISTING_INSTALL" = true ] && [ "$FORCE_DB_REINIT" != "true" ]; then
                error "=========================================================="
                error "DATA LOSS PREVENTION: Database appears corrupt or missing"
                error "=========================================================="
                error ""
                error "Found existing secrets but PostgreSQL data is invalid."
                error "This usually means:"
                error "  1. Volume was not properly mounted after container update"
                error "  2. Database was corrupted"
                error ""
                error "If this is a FRESH INSTALL, set: FORCE_DB_REINIT=true"
                error "If this is an UPDATE, check your volume mounts!"
                error ""
                error "Your data may still exist in a Docker volume."
                error "Run: docker volume ls | grep tracearr"
                error "=========================================================="
                exit 1
            fi
            warn "Data directory has no valid database (missing global/pg_control)"
            warn "Initializing fresh database..."
            rm -rf /data/postgres/*
            chown -R postgres:postgres /data/postgres
            gosu postgres /usr/lib/postgresql/15/bin/initdb -D /data/postgres
            init_postgres_db
        fi
    else
        # Empty directory - initialize fresh
        # Note: Existing secrets (JWT/cookie) don't indicate data loss risk since
        # they only affect auth sessions, not actual data. If postgres is empty,
        # there's no user data to protect anyway.
        if [ "$EXISTING_INSTALL" = true ]; then
            warn "Found existing secrets but empty database - initializing fresh"
            warn "Previous sessions will be invalidated (users will need to log in again)"
        fi
        chown -R postgres:postgres /data/postgres
        gosu postgres /usr/lib/postgresql/15/bin/initdb -D /data/postgres
        init_postgres_db
    fi
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
# Tune PostgreSQL for available resources (runs every startup)
# =============================================================================
# timescaledb-tune automatically optimizes PostgreSQL settings based on
# available RAM and CPU. Safe to run repeatedly - recalculates if resources change.
if command -v timescaledb-tune &> /dev/null; then
    log "Tuning PostgreSQL for available resources..."
    timescaledb-tune --pg-config=/usr/lib/postgresql/15/bin/pg_config \
        --conf-path=/data/postgres/postgresql.conf \
        --yes --quiet 2>/dev/null || warn "timescaledb-tune failed (non-fatal)"
fi

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
