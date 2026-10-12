#!/bin/bash
# Browser flows against the local stack (Chromium + fake mic + Realtime mock), each on a fresh seed.
#   bash tests/e2e/setup.sh            # once per container
#   bash tests/e2e/run.sh [port]       # builds, serves, runs; FLOWS="auth" to pick
# Run before deploying any change to audio / walkie / push-to-talk code (src/lib/walkie, src/lib/audio.ts,
# src/hooks/use-recorder.ts, use-push-to-talk.ts): in Speak these flows caught every walkie regression.
S="$(cd "$(dirname "$0")" && pwd)"
P=${1:-8899}
bash "$S/local-build.sh" "$P" 2>&1 | tail -1
fail=0
for f in ${FLOWS:-auth map social walkie walkie-ios walkie-robust walkie-hub walkie-reconnect nearby nav reports release}; do
  bash "$S/reset-local.sh" >/dev/null 2>&1
  rm -rf "$S/storage-files"
  out=$(cd "$S" && timeout 400 node "$f-flow.mjs" "$P" 2>&1)
  p=$(grep -c '^PASS' <<<"$out"); x=$(grep -c '^FAIL' <<<"$out")
  echo "$f: pass=$p fail=$x"; grep -E '^(FAIL|errors:)' <<<"$out" | sed 's/^/    /'
  # A flow that crashed never prints its "errors:" line: show how it ended.
  grep -q '^errors:' <<<"$out" || { echo "    CRASHED:"; tail -15 <<<"$out" | sed 's/^/      /'; fail=1; }
  { [ "$x" -eq 0 ] && [ "$p" -gt 0 ]; } || fail=1
done
exit $fail
