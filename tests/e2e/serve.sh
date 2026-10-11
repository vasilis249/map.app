#!/bin/bash
# Serve the built app on port $1 (stops a previous preview on that port first). Fully detached.
S="$(cd "$(dirname "$0")" && pwd)"
cd "$S/../.."
[ -f $S/preview-$1.pid ] && kill $(cat $S/preview-$1.pid) 2>/dev/null
nohup timeout 1800 npx vite preview --port $1 --host 127.0.0.1 --strictPort > $S/preview-$1.log 2>&1 < /dev/null & echo $! > $S/preview-$1.pid
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:$1/ && break; sleep 1; done
