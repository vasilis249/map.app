#!/bin/bash
# Recreate the local "mapapp" DB (served by PostgREST) with the schema, the local-only auth + Realtime mock helpers
# and the seed users.
S="$(cd "$(dirname "$0")" && pwd)"
cd "$S/../.."
export PGHOST=/tmp PGPORT=54329 PGUSER=postgres
psql -q -c "drop database if exists mapapp with (force)" -c "create database mapapp" >/dev/null || { echo "reset: drop failed"; exit 1; }
psql -q -d mapapp -f supabase/tests/supabase_stubs.sql >/dev/null 2>&1
for m in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d mapapp -1 -f "$m" >/dev/null 2>&1 || echo "failed $m"; done
psql -q -d mapapp -f "$S/rt_mock.sql"
psql -q -d mapapp -f "$S/local_auth.sql"
psql -q -d mapapp -f "$S/seed.sql"
psql -q -d mapapp -c "NOTIFY pgrst, 'reload schema'"
