#!/bin/bash
# One-time setup of the local stack in a fresh container (no Docker): Postgres 16 cluster on :54329, PostgREST
# 12.2.3, the fake-mic tone. Idempotent. Used by the SQL suites (npm run test:db) and the browser flows.
S="$(cd "$(dirname "$0")" && pwd)"
PGDATA=/var/lib/postgresql/mapapp-test
PGBIN=/usr/lib/postgresql/16/bin
if [ ! -d "$PGDATA" ]; then
  install -d -o postgres -g postgres "$PGDATA"
  su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
fi
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p 54329 -k /tmp' -l /tmp/pg-mapapp.log status" >/dev/null 2>&1 \
  || su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p 54329 -k /tmp' -l /tmp/pg-mapapp.log -w start" >/dev/null
if [ ! -x "$S/pgrst/postgrest" ]; then
  curl -sSL -o "$S/pgrst/pgrst.tar.xz" https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz \
    && tar -xJf "$S/pgrst/pgrst.tar.xz" -C "$S/pgrst" && rm "$S/pgrst/pgrst.tar.xz"
fi
[ -f "$S/tone440.wav" ] || python3 - "$S/tone440.wav" <<'PY'
import math, struct, sys, wave
w = wave.open(sys.argv[1], "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / 48000))) for i in range(48000 * 6))); w.close()
PY
bash "$S/reset-local.sh"
echo "setup done"
