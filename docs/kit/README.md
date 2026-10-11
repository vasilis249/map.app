# Maps + live push-to-talk starter kit (from the Speak app)

Working, production-tested code from **Speak** (a voice-first social app: TanStack Start + React 19 + Supabase +
Capacitor 8 iOS shell, hosted on Cloudflare Workers). It already does: live own position + friends / nearby people on a
MapLibre map, server-enforced "who is within N metres", knock-then-talk push-to-talk with strangers nearby, a 1-to-1
walkie-talkie between friends (live binary audio over Supabase Realtime private channels, saved copy for replay),
follow/block/report, and the iOS background-location + audio plumbing. **Port it; don't rewrite it** — every odd-looking
line in `engine.ts`, `tracker.ts`, `live-map.tsx` and `audio.ts` fixes a bug found on a real iPhone (see LESSONS.md).

Paths under `web/` are the original repo paths (`src/...`), so files can be dropped into a TanStack Start + Vite project
with the `@/` alias = `src/`.

## Inventory

### Map + location (`web/src/lib/location`, `web/src/components/map`, `web/src/components/location`)
| File | What it does | Depends on |
|---|---|---|
| `lib/location/tracker.ts` | Position tracking: native `@capacitor-community/background-geolocation` (Always, distanceFilter 5, temporary full accuracy) with fallback to `navigator.geolocation`; smart send rules (moved > max(8 m, accuracy), better fix, drift, 60 s heartbeat), ignores bad jumps; `watchLocal` (foreground watch for the map, ref-counted), `localFix`/`onLocalFix`, `hasNativeLocation`, `openLocationSettings` | `lib/native`, `lib/location/api` |
| `lib/location/api.ts` | RPC wrappers: sharing mode, `update_my_location`, `map_people(radius)`, query keys | supabase client |
| `lib/location/nearby.ts` | Knock-then-talk state for strangers nearby (holds a conversation 3 min, ≤ 6 open), knock / history / audio RPCs | walkie hub, api |
| `lib/location/format.ts` | `formatDistance`, haversine | — |
| `lib/location/compass.ts` | Device compass (iOS `webkitCompassHeading` + permission, Android absolute orientation) | — |
| `components/map/live-map.tsx` | MapLibre map (loaded on demand, **worker URL fix**), OpenFreeMap liberty/dark styles following light/dark, own marker (photo, accuracy halo, heading beam, ping), people markers that glide, radius circle, `localizeLabels` (el/en) | maplibre-gl, `lib/location/*`, user-avatar |
| `components/map/nearby-talk.tsx` | The person card's push-to-talk (knock → live), status lines, last-24 h history | `hooks/use-walkie`, nearby.ts |
| `components/location/location-sync.tsx` | Root component: tracks while sharing is on, listens to the `nearby-in:<me>` knock inbox | tracker, nearby |
| `routes/_authenticated/map.tsx` | Full map screen: tabs Friends / Nearby (radius chips), friends strip, person card (walkie, directions handoff, profile, ⋯ report/block), "can't find your location" states | everything above |
| `routes/_authenticated/location.tsx` | Sharing settings (off / friends / everyone, who may talk to me) | api |

### Walkie-talkie / push to talk (`web/src/lib/walkie`, `web/src/hooks`, `web/src/components/walkie`)
| File | What it does |
|---|---|
| `lib/walkie/codec.ts` | 16 kHz μ-law, 0.25 s pieces with header (version, seq), `Downsampler` |
| `lib/walkie/engine.ts` | `WalkieSession(me, peer, kind 'walkie' \| 'nearby')`: private Realtime channel `<kind>:<a>:<b>`, presence, binary broadcast `audio` framed by `start`/`end`, floor control, jitter buffer, watchdog, beeps, **iOS audio-session + `wakeAudio()` handling**, **backlog until joined (never REST-fallback binary)**, cancel too-short presses, replay of the saved copy when a live reception was incomplete, anomaly diagnostics, reconnect with backoff |
| `lib/walkie/hub.ts` | Registry: one session per peer, pinned "channel on" sessions, ref-counted acquire, peerStart → silence other audio |
| `lib/walkie/history.ts` | Saved transmissions (24 h) |
| `lib/walkie/keepalive.ts` | Opt-in silent loop to keep listening with the screen locked (App Review risk, see LESSONS) |
| `hooks/use-walkie.ts` | React binding of a session (snapshot, press/release, unlock audio) |
| `hooks/use-push-to-talk.ts` | Hold-to-record gesture (pointer capture, no iOS callout/text selection, min hold) |
| `hooks/use-recorder.ts` | MediaRecorder with the **audio-session switch before getUserMedia** and mic error mapping |
| `components/walkie/walkie-hub.tsx` | Root sync (pins, unlock on first tap, local notice when hidden) + top banner "X is talking to you" |
| `components/walkie/history-row.tsx` | Replay row |
| `routes/_authenticated/talk.$userId.tsx`, `talk.index.tsx` | 1-to-1 walkie screen + list of friends with channel switches |

### Shared plumbing
`lib/audio.ts` (shared player, `setAudioSession`, `silenceAll`), `lib/native.ts` (`isNativeApp`, deep links),
`lib/haptics.ts`, `lib/friends.ts` (follow / block / report API), `lib/notifications.ts`, `lib/time-ago.ts`,
`lib/avatar.ts`, `components/user-avatar.tsx`, `components/voice/voice-icon.tsx`, `components/app-header.tsx`,
`components/segmented.tsx`, `components/empty-state.tsx`, `components/friends/person-actions-sheet.tsx` (report/block
sheet), `integrations/supabase/client.ts` (PKCE in the app), `lib/security-headers.server.ts` (CSP: tiles host, ws:,
`Permissions-Policy` microphone + geolocation), `design-system.css` (tokens the components use), `vite.config.ts`
(**`worker.format: "es"` for MapLibre**), `package.json` (versions that work together).

### Native (`native/`)
`capacitor.config.ts`, `ios/App/App/Info.plist` (mic / location When-in-use + Always + temporary full accuracy purpose
key `SpeakMap`, `UIBackgroundModes` audio + location, no forced dark), `ios/App/CapApp-SPM/Package.swift`,
`scripts/patch-native-plugins.mjs` (run by `ios:sync`: lifts the background-geolocation plugin to capacitor-swift-pm
8.x and adds the reduced-accuracy → full-accuracy request with `#available(iOS 14)`).

### Database (`db/`)
`migrations-reference/` — the Speak migrations that define the features, **verbatim, as reference**: they sit on
Speak's schema (`profiles`, `follows`, `blocks`, `notifications`, `reports`, `private.me()`, `private.are_friends`,
`private.rate_events`, a student gate). Write ONE fresh baseline for the new app and port the function bodies:
- `20261021100000_live_location.sql` — `location_sharing`, `private.user_locations` (latest only), `update_my_location`
  (≤ 1 write / 3 s), `map_people(radius)`, `private.are_nearby`, expiry cron.
- `20261022100000_live_map.sql`, `20261024100000_map_last_seen.sql` — own position, last-known friends (1 h), strangers
  only when fresh (15 min), accuracy.
- `20261023100000_nearby_talk.sql` — knock (`nearby_knock` → `realtime.send` to `nearby-in:<uid>`), pair-channel RLS on
  `realtime.messages` (`nearby:<a>:<b>`), `send_nearby`, history, rate limits (30 different people / h).
- `20261015100000_speak_walkie.sql`, `20261018100000_walkie_contacts.sql` — friends walkie: saved audio (bytea, 24 h),
  `walkie:<a>:<b>` channel RLS, channel on/off, unheard counts. `20261029100000_walkie_diag.sql` — anomaly counters.
- `20261003100000_voice_baseline.sql`, `20261005100000_speak_social.sql`, `20261007100000_speak_people.sql` — where
  profiles / follows / blocks / notifications / reports / rate limiting come from (take only those parts).
- `20261027100000_student_gate.sql` — NOT needed (Speak is students-only); shows the `private.me()` gate pattern.
`tests/` — `supabase_stubs.sql` (fakes auth / storage / realtime / roles so plain Postgres can run the migrations),
`run.sh`, and the SQL test suites for location (26), nearby (28), walkie (28): port them with the baseline.

### Tests in a browser (`e2e/`)
No Docker needed: `setup.sh` (initdb on :54329, downloads PostgREST 12.2.3, makes `tone440.wav`), `local-supabase.mjs`
(auth/storage/REST proxy), `realtime-mock.mjs` (Phoenix vsn 2.0.0: JSON + binary broadcasts, presence, private joins
authorized by the real RLS policies via `rt_mock.sql`), `run.sh` (builds, serves with wrangler, runs the flows on a fresh
seed). Flows: walkie (two browsers, fake mic), walkie-ios (models iOS suspending Web Audio on session switches),
walkie-robust (socket cut, short press), walkie-hub, walkie-reconnect, nearby (strangers: knock → live → saved →
answer → refusal), micsession, ptt. Seeds/ids are Speak's — rewrite them for the new schema.

### `scripts/rt-probe/`
A throw-away Cloudflare Worker that joins the REAL Supabase Realtime private channel as two test users and checks binary
pieces + presence arrive (deploy temporarily, delete it and the users after).
