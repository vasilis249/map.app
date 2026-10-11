#!/bin/bash
# Build against the local stack and serve it (vite preview = the built Worker in workerd) on port $1.
S="$(cd "$(dirname "$0")" && pwd)"
cd "$S/../.."
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/mapapp-test -o '-p 54329 -k /tmp' -l /tmp/pg-mapapp.log status" >/dev/null 2>&1 \
  || su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/mapapp-test -o '-p 54329 -k /tmp' -l /tmp/pg-mapapp.log -w start" >/dev/null
curl -s -o /dev/null http://127.0.0.1:54321/auth/v1/health || bash $S/stack.sh >/dev/null 2>&1
ENV=$(node $S/local-env.mjs)
# Server-side vars for the preview Worker (git-ignored); the client gets the VITE_* ones at build time.
grep -v '^VITE_' <<<"$ENV" > .dev.vars
env $(grep '^VITE_' <<<"$ENV" | xargs) npx vite build > $S/build-local.log 2>&1 || { echo build-failed; tail -20 $S/build-local.log; exit 1; }
bash $S/serve.sh $1
curl -s -o /dev/null -w "serve:%{http_code}\n" http://127.0.0.1:$1/login
