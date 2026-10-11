# Build: a social navigation app ("Waze + people nearby + push-to-talk")

You are building a new iOS-first mobile app from an empty repository. **Reply to me in Greek; write code, comments and
file names in English.** Work in phases; at the end of every phase STOP, summarize in ≤ 10 lines (what works, what was
verified and how, what is NOT verified), and wait for my "OK". Keep a `CLAUDE.md` in the repo with decisions,
architecture and per-phase findings, updated at every phase.

## Starter kit — read it first
The folder `maps-kit/` (I put it in the repo root) contains working, production-tested code from my previous app
(Speak): live map with MapLibre, location tracking (native + web fallback), server-enforced "people within N metres",
friends map, knock-then-talk push-to-talk with strangers nearby, a 1-to-1 live walkie-talkie over Supabase Realtime
(binary audio, saved copy, replay), follow / block / report, iOS native config, SQL tests and a Docker-free browser
test harness with a Realtime mock.
1. Read `maps-kit/README.md` (inventory + dependencies) and `maps-kit/LESSONS.md` (26 bugs already solved on real
   iPhones) before writing any code.
2. **Port, don't rewrite.** Copy files into place, adapt imports, names and the database schema. Every unusual line in
   `engine.ts`, `tracker.ts`, `live-map.tsx`, `audio.ts`, `use-recorder.ts`, `use-push-to-talk.ts` fixes a real bug.
   If you think something there is wrong, tell me before changing it.
3. The SQL in `maps-kit/db/migrations-reference/` sits on the old app's schema. Write ONE fresh baseline migration for
   this app (profiles, follows, blocks, notifications, reports, rate limiting, location, nearby talk, walkie) and port
   the function bodies and RLS policies; port the SQL test suites with it.
4. When everything is ported and green, delete `maps-kit/` from the repo (keep anything still useful under `docs/`).

## Product
A map-first social app for people on the move (driving, walking, cycling).
1. **Live map.** Your own position live (photo marker, accuracy halo, heading). Everyone who shares and is **within 200 m
   of you** appears on the map in real time (avatar markers that glide, fade when stale). The radius is enforced by the
   server, never by the client. Reciprocity: you only see others while you share yourself. Tap a person → card:
   name, @username, distance, Follow, Talk (push-to-talk), Profile, ⋯ (report / block).
2. **Social like Instagram/X.** Profiles (photo, name, @username, bio), follow (public, asymmetric, no approval),
   followers / following lists, mutual follow = friends, search by name/username, notifications (follows, knocks,
   missed transmissions), block (hides both ways everywhere, including the map and talk) and report.
   Friends can see each other on the map at any distance (setting), strangers only within 200 m.
3. **Live push-to-talk.** Hold a big button and speak; the other person hears you live, like a walkie-talkie.
   With someone within 200 m: the kit's knock-then-talk flow (the server checks distance + rate limits, the other phone
   joins the pair channel, your first words are buffered until then). With friends at any distance: the kit's 1-to-1
   walkie. One speaker at a time, 60 s max, a saved copy kept 24 h for replay, "X is talking to you" banner anywhere in
   the app, works with the iPhone's silent switch.
4. **Real turn-by-turn navigation.** Search a destination (autocomplete), pick a route (alternatives with ETA /
   distance), start navigation: camera follows heading-up with pitch, current instruction + next maneuver banner,
   distance to the turn, lane-free voice guidance in Greek (TTS: native plugin, Web Speech fallback) at sensible
   distances, off-route detection with debounced automatic rerouting, ETA updates, arrival. Keeps working with the
   screen off (background location + audio for guidance). While navigating, the map still shows people within 200 m and
   push-to-talk still works (voice guidance ducks while someone talks).
5. **Waze-style reports.** Drop a report on your current position (accident, police, hazard, traffic jam, closed road);
   others near it or whose route passes it see it; thumbs up/down ("still there?"); reports expire automatically.

## Technical direction (defaults — tell me if you disagree, with reasons)
- Same stack as the kit, so it ports cleanly: TanStack Start (React 19, Vite, file routes) + Tailwind + TanStack Query
  + i18next (el / en), Supabase (Postgres + RLS + RPCs + Realtime + Storage + pg_cron), Capacitor 8 iOS shell (SPM),
  hosting on Cloudflare Workers. Map: MapLibre GL + OpenFreeMap tiles (free, no key).
- Routing + geocoding: recommend a provider after comparing free tiers and terms (e.g. OpenRouteService, GraphHopper,
  Stadia Maps/Valhalla; Photon/Nominatim for search with their usage policies). Call it through a server function so
  keys never reach the client; cache; respect rate limits. Make the provider swappable behind one module.
- Positions: latest only per user (no history), expire after inactivity; adaptive update rate by speed (driving needs
  ~1–2 s / 15–25 m, standing still a heartbeat); writes rate-limited server-side.
- Every table has RLS; `SECURITY DEFINER` functions with `search_path = ''`; the service-role key never ships; a deploy
  script refuses a bundle without the Supabase URL/anon key or containing the service key.

## Safety, privacy, legal (non-negotiable)
- Location sharing is opt-in, off by default, with a clear explanation; a one-tap "ghost mode"; nothing visible to
  blocked users; no position history stored; age limit (ask me; recommend 18+ for showing exact positions to strangers).
- Driving: push-to-talk must be one large target usable without looking (no typing while moving); show a one-time
  safety notice; no interaction that needs reading while the car moves (respect App Store guidelines about
  distraction). Voice guidance and talk must coexist (duck, never cut the guidance silently).
- Report/block on every person card and talk screen; a moderation queue for admins.
- Privacy policy + terms covering location, voice, retention, third-party map/routing providers (draft them; I will
  add the legal entity).

## Decisions to ask me before Phase 1 (give a recommendation for each)
App name and bundle id; iOS only or iOS + Android; Apple Developer Program now (needed for TestFlight, push
notifications, and a real background-mode review) or later; routing/geocoding provider; whether friends are visible
beyond 200 m; age limit; walking/cycling profiles or driving only at first.

## Phases (stop for my "OK" after each)
- **P0 Setup + port:** repo, stack, CI-free local test setup (Postgres + PostgREST + stubs, the e2e harness), baseline
  migration, auth (email + password; Apple/Google later), profiles, the kit ported and compiling, SQL tests green.
- **P1 Live map + 200 m:** sharing settings, tracker, map screen, people within 200 m (server-side), friends layer,
  person card, ghost mode. Tests: SQL (radius, reciprocity, staleness, blocks) + browser flow with two users and
  Playwright geolocation.
- **P2 Social:** follow, lists, search, profiles, notifications, block/report, moderation basics.
- **P3 Push-to-talk:** knock-then-talk within 200 m + friends walkie + banner + history. All walkie/nearby e2e flows from
  the kit pass (rewrite seeds for the new schema). Then a manual test on two real iPhones with my help.
- **P4 Navigation:** search, routes, turn-by-turn UI, Greek TTS, reroute, background navigation, talk during
  navigation. Tests: route parsing, off-route logic and maneuver timing as unit tests with recorded GPS tracks
  (simulate a drive), plus a browser flow.
- **P5 Reports:** create / see / confirm / expire, along-route filtering, rate limits, abuse handling.
- **P6 Hardening + release:** performance and battery pass, legal texts, App Store privacy labels, review notes,
  release checklist, icon/splash.

## How to work
- Before each phase: a short plan (tasks with acceptance criteria). After: run every test suite; never mark something
  verified that you didn't run; list what still needs a real device.
- Small commits with clear messages; never commit secrets (I'll give keys in chat — keep them out of the repo and tell
  me to rotate them afterwards).
- Prefer the simplest thing that works; no speculative abstractions; but never cut security, privacy, input
  validation or error handling that prevents data loss.
