# Lessons already paid for (Speak, 2026-09/10) — read before touching map, location or audio code

## iOS audio (WKWebView / Safari)
1. **Any change of `navigator.audioSession.type` pauses every Web Audio context, and nothing resumes it.** Press →
   `play-and-record`, release → `playback`, a recording elsewhere → back. Symptom: the sender's ScriptProcessor never
   runs (no live pieces, only the saved copy arrives) and the receiver drops everything. Fix in `engine.ts`:
   `wakeAudio()` (resume without a gesture, 1 s cap) after getUserMedia, after release, and from `ctx.onstatechange`
   while sessions are open; hold the last ~2 s of received pieces while paused and play them once running.
2. **WebKit refuses `getUserMedia` while the audio session is `playback`.** Any open walkie session sets playback
   app-wide, so a normal recorder must switch to `play-and-record` BEFORE asking for the mic and restore after
   (`use-recorder.ts`). Map NotAllowed/Security → "denied", anything else → "busy" (don't tell users to grant a
   permission they already granted).
3. **iOS getUserMedia takes 0.8–1.4 s.** A press shorter than that must be cancelled (send nothing) and the user told
   "hold until the beep" — otherwise an empty start/end goes out.
4. Shared `<audio>` player: call `prime()` synchronously inside the tap so iOS allows playback after an async RPC.
5. Long-press on a button triggers WebKit text selection / loupe and cancels the pointer at ~0.5 s → every
   push-to-talk button needs `user-select: none`, `-webkit-touch-callout: none`, `touch-action: none`, pointer capture.
6. A silent audio loop keeps the app alive with the screen locked (`keepalive.ts`) — opt-in only; App Review 2.5.4
   risk. For a navigation app the legitimate background modes are `location` (while navigating) and `audio` (voice
   guidance / PTT).

## Supabase Realtime
7. **realtime-js `channel.send()` on a channel that is not joined silently falls back to the REST broadcast endpoint,
   which JSON-encodes the payload → a binary ArrayBuffer piece arrives as `{}`.** Only send when the channel is
   `joined` AND the socket is connected; otherwise queue and flush on SUBSCRIBED (`engine.ts` `canPush/out/tryFlush`).
8. Binary broadcast needs supabase-js ≥ 2.91 (Speak uses 2.117). Private channels are authorized by RLS policies on
   `realtime.messages` — the topic encodes the pair (`walkie:<smaller uuid>:<larger uuid>`) and a SQL function checks
   the caller is one of the two AND still allowed (friends / nearby / not blocked). Re-check on every join.
9. If a live reception was incomplete (no start, or < 80 % of `end.ms/250` pieces played), replay the SAVED copy — users
   then always hear the message.
10. Free tier: 200 concurrent connections, 100 msg/s, 2 M messages/month; one 0.25 s piece = 1 sent + 1 received.
    Plan a paid tier (or a dedicated media server / WebRTC SFU) before real traffic.
11. `realtime.send(payload, event, topic, private)` from SQL is how the server pushes a "knock" to a user's inbox topic
    after it has validated distance and rate limits — clients never write to someone else's inbox.

## Location
12. The plugin already asks Core Location for Best accuracy and never pauses; precision losses were in our own
    throttling. Send rules that work: moved > max(8 m, fix accuracy ≤ 50 m), clearly better fix (< 0.6× last error),
    every 30 s while drifting ≥ 3 m, 60 s heartbeat when still (iOS sends no fixes when you stand still), ignore a much
    worse fix right after a good one. For driving: adapt by speed (e.g. every 1–2 s / 15–25 m).
13. iOS 14+ "Precise: off" → `requestTemporaryFullAccuracyAuthorization(withPurposeKey:)` + Info.plist
    `NSLocationTemporaryUsageDescriptionDictionary`; the plugin targets iOS 13 so wrap it in `if #available(iOS 14.0, *)`
    (patched by `patch-native-plugins.mjs`).
14. The background-geolocation plugin's Package.swift pins capacitor-swift-pm 7.x → patch to 8.x on every sync.
15. An app binary built before a native plugin was added doesn't have it: `Capacitor.isPluginAvailable` and fall back to
    `navigator.geolocation` (foreground) instead of failing silently. The web part updates from the server, the native
    part only with a new Xcode build.
16. **Never return a Capacitor plugin proxy from an async function / resolve a promise with it** — the proxy's `then`
    gets called → native "then() is not implemented". Wrap it (`{ plugin }`).
17. Server-side truth for "who is near": the client sends only its own fix; the database computes distances
    (haversine), applies the radius, freshness (stale positions hidden), reciprocity (you must share to see), blocks and
    disabled accounts. Keep only the latest position per user (no history) and expire it (cron).
18. Web: `Permissions-Policy: geolocation=(self), microphone=(self)` — an empty `()` silently blocks the web APIs.

## MapLibre
19. **MapLibre ≥ 5 ESM loads its worker via `new URL('./maplibre-gl-worker.mjs', import.meta.url)`, which Vite doesn't
    emit → no tiles, no streets, no labels (only your own markers render).** Fix: `import workerUrl from
    "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"; maplibregl.setWorkerUrl(workerUrl)` + `worker: { format: "es" }`
    in vite.config.
20. MapLibre's CSS makes the container `position: relative` — put it in an inner full-size div. First framing with
    `cameraForBounds` + `jumpTo` (an animated fitBounds never finished while the style loaded). Re-add overlays on
    `style.load` when switching light/dark styles. Localize labels (`name:el` › `name` › `name:latin`).
21. OpenFreeMap (`tiles.openfreemap.org`, styles liberty / dark) is free with no key — add it to CSP `connect-src`.

## Data / platform
22. The Supabase REST API returns at most 1000 rows per request — page any list that can grow (`.range()`).
23. pg_net does not follow redirects — store final URLs for anything fetched from the database.
24. Keep `SECURITY DEFINER` functions with `SET search_path = ''`; revoke EXECUTE from `anon`/`PUBLIC`; a blanket
    `GRANT EXECUTE ON ALL FUNCTIONS` in a later migration re-grants service-only functions — guard those with an
    invoker wrapper that checks `current_user`.
25. Deploy guard: a client bundle built without the Supabase URL / anon key (or WITH the service key) must fail the
    deploy script. Never ship the service-role key; RLS on every table.
26. Testing without Docker works: Postgres + PostgREST + `supabase_stubs.sql` for SQL suites, the local proxy +
    realtime mock for browser flows with two Chromium instances and a fake microphone. The real Realtime path and a real
    iPhone still need a manual test with two accounts.
