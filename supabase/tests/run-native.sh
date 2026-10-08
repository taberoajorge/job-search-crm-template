#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
# Supabase runs PostgreSQL 17; this fallback lacks pg_cron, pg_net, Vault and the Auth/Storage services.
PG_BIN=${PG_BIN:-$(for v in 17 16; do d=/opt/homebrew/opt/postgresql@$v/bin; [ -x "$d/psql" ] && echo "$d" && break; done)}
TEST_DIR=$(mktemp -d /tmp/crm-pg.XXXXXX)
TEST_PORT=${CRM_TEST_PORT:-55439}
cleanup() { "$PG_BIN/pg_ctl" -D "$TEST_DIR/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TEST_DIR"; }
trap cleanup EXIT INT TERM
"$PG_BIN/initdb" -D "$TEST_DIR/db" -A trust --no-locale > "$TEST_DIR/init.log"
"$PG_BIN/pg_ctl" -D "$TEST_DIR/db" -l "$TEST_DIR/server.log" -o "-p $TEST_PORT -k $TEST_DIR -h 127.0.0.1" start > "$TEST_DIR/start.log"
export CRM_TEST_DATABASE_URL="postgresql://$(whoami)@127.0.0.1:$TEST_PORT/postgres"
"$PG_BIN/psql" "$CRM_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/platform.fixture >/dev/null
for migration in supabase/migrations/*.sql; do "$PG_BIN/psql" "$CRM_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$migration" > "$TEST_DIR/migration.log"; done
"$PG_BIN/psql" "$CRM_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/security.fixture
"$PG_BIN/psql" "$CRM_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/advanced.fixture
"$PG_BIN/psql" "$CRM_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/job-filters.fixture
"$PG_BIN/psql" "$CRM_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/audit-retention.fixture
"$PG_BIN/psql" "$CRM_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/contact-erasure.fixture
for fixture in automation company-understanding notifications recent-updates resume-adoption hardening; do "$PG_BIN/psql" "$CRM_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "supabase/tests/$fixture.fixture"; done
python3 supabase/tests/concurrency.py

corepack pnpm exec tsx --test scripts/automation/understanding.test.ts
