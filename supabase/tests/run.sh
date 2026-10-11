#!/usr/bin/env bash
# Local database tests without Docker: a throwaway Postgres 16 DB with Supabase-like stubs (auth / storage / realtime
# schemas, anon / authenticated / service_role), all migrations, then each suite prints PASS / FAIL lines.
#   bash tests/e2e/setup.sh     # once per container: Postgres cluster on :54329 (+ PostgREST for the browser flows)
#   npm run test:db
set -uo pipefail
cd "$(dirname "$0")/../.."
export PGHOST=${PGHOST:-/tmp} PGPORT=${PGPORT:-54329} PGUSER=${PGUSER:-postgres}
DB=${TEST_DB:-mapapp_test}
ERR=$(mktemp)
fail=0
for suite in supabase/tests/test_*.sql; do
  psql -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DB' and pid <> pg_backend_pid()" >/dev/null
  psql -q -v ON_ERROR_STOP=1 -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 1
  psql -q -d "$DB" -f supabase/tests/supabase_stubs.sql >/dev/null 2>&1
  for m in supabase/migrations/*.sql; do
    psql -q -v ON_ERROR_STOP=1 -d "$DB" -1 -f "$m" >/dev/null 2>"$ERR" \
      || { echo "migration failed: $m"; grep -v NOTICE "$ERR"; exit 1; }
  done
  out=$(psql -q -d "$DB" -f "$suite" 2>&1)
  pass=$(grep -c PASS <<<"$out"); failed=$(grep -c FAIL <<<"$out")
  # Any SQL error outside a checked statement is a failure too (a test that never ran must not look green).
  errors=$(grep -E '^psql:.*ERROR' <<<"$out")
  echo "$(basename "$suite"): PASS $pass FAIL $failed"
  grep FAIL <<<"$out"
  [ -n "$errors" ] && { echo "$errors"; fail=1; }
  [ "$failed" -eq 0 ] && [ "$pass" -gt 0 ] || fail=1
done
rm -f "$ERR"
exit $fail
