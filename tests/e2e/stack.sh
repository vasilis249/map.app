#!/bin/bash
# (Re)start PostgREST + the local Supabase proxy (auth, storage, realtime mock); pids in $S/*.pid.
# Both are fully detached (own stdin/stdout/stderr), so a caller's pipe never waits for them.
S="$(cd "$(dirname "$0")" && pwd)"
for f in $S/pgrst.pid $S/proxy.pid; do [ -f $f ] && kill $(cat $f) 2>/dev/null; done
sleep 1
cd $S/pgrst && nohup ./postgrest postgrest.conf > $S/pgrst.log 2>&1 < /dev/null & echo $! > $S/pgrst.pid
nohup node $S/local-supabase.mjs > $S/local-supabase.log 2>&1 < /dev/null & echo $! > $S/proxy.pid
for i in $(seq 1 20); do curl -s -o /dev/null http://127.0.0.1:3001/ && break; sleep 0.5; done
for i in $(seq 1 20); do curl -s -o /dev/null http://127.0.0.1:54321/auth/v1/health && break; sleep 0.5; done
curl -s -o /dev/null -w "proxy:%{http_code}\n" http://127.0.0.1:54321/auth/v1/health
