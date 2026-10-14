# Release checklist (first TestFlight / App Store release)

Tick each line; anything not done is a reason not to ship. Owner = you (decisions, accounts, legal); dev = code / me.

## 1. Decisions and accounts (owner)
- [ ] App name and bundle id → `src/lib/brand.ts`, `capacitor.config.ts` (CAP_APP_ID), `ios/App/App/Info.plist`,
      `wrangler.jsonc` (`name`), App Store Connect app record. Icon has no text, so it stays.
- [ ] Legal entity, address, contact email, courts city → `src/lib/brand.ts` (`LEGAL`).
- [ ] A lawyer reviews `src/legal/content.ts` (privacy policy + terms, el / en drafts).
- [ ] Apple Developer Program (team), App Store Connect app, agreements / tax / banking (if paid).
- [x] Supabase project (`pdajcrlxeqggeucfqmpg`), Cloudflare account (workers.dev subdomain `vasilis-har`).
- [ ] Stadia Maps (Starter plan: commercial use).

## 2. Backend (dev, with the owner's accounts)
- [x] Supabase: run `supabase/migrations/20261011100000_baseline.sql` (from now on only NEW migrations — D11 ends).
- [ ] Extensions: `pg_cron` on **before** the migration (else re-run its last `DO $cron$` block): jobs expire-locations,
      expire-nearby, expire-walkie, expire-misc, expire-road.
- [ ] Realtime → "Allow public access" **off** (private channels only).
- [ ] Auth: email confirmations on; URL configuration: the web app URL + `mapapp://app/login` (new scheme if renamed);
      SMTP of your own (Supabase's default sender is rate-limited).
- [ ] Storage: bucket `avatars` exists (the migration creates it), 5 MB, jpeg/png/webp.
- [ ] Admins: `insert into private.admins (user_id) values ('<uuid>')` for the moderators.
- [ ] Demo accounts for App Review (2, 18+, following each other).

## 3. Web app on Cloudflare (dev)
- [x] `.env` (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY) — publishable key only.
- [x] Worker secrets: `wrangler secret put SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.
- [ ] Worker secret `ROUTING_API_KEY` (Stadia; navigation answers "unavailable" until then).
- [x] `npm run deploy` passes the bundle guard; `/privacy` and `/terms` load without an account
      (https://map-app.vasilis-har.workers.dev, first deploy 2026-10-14).
- [ ] A custom domain (privacy policy / support URLs on your domain).

## 4. iOS build (owner's Mac + dev)
- [ ] `npm ci && npm run ios:sync` (patches the location plugin, adds the TTS / keep-awake plugins), `CAP_SERVER_URL`
      = the production URL.
- [ ] Xcode: Team, bundle id, version / build number; Signing & Capabilities: Background Modes (Location updates,
      Audio) are in Info.plist; `PrivacyInfo.xcprivacy` is in the target (Copy Bundle Resources).
- [ ] Archive → TestFlight (internal).

## 5. Device tests on TestFlight (owner + me) — must pass
- [ ] `docs/DEVICE-TEST-P3.md` (push-to-talk, two iPhones).
- [ ] `docs/DEVICE-TEST-P4.md` (navigation: voice, locked screen, reroute, smooth motion, 3D at a light, speedometer).
- [ ] Road reports on a drive (warning in time, still there?).
- [ ] Delete account on a device (Profile → Delete account) → can't sign in, photo URL 404.
- [ ] 30-minute drive: battery % and heat noted; 1 hour of sharing with the app in the background noted.

## 6. App Store Connect (owner, with `docs/release/APP-STORE.md`)
- [ ] Privacy labels, age rating 18+, review notes, demo accounts, privacy / support URLs.
- [ ] Screenshots (6.7" and 6.1") without real users' data; description, keywords; category Navigation.
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption = false` already in Info.plist (HTTPS only).

## 7. After release
- [ ] Rotate every key that was ever pasted into a chat (Supabase, Stadia, Cloudflare tokens).
- [ ] Moderation: someone checks the queue daily (Apple expects action within 24 h).
- [ ] Supabase free-tier limits (Realtime connections / messages) — plan the paid tier before real traffic
      (LESSONS #10).
