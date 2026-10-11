# Speak starter kit — what is kept here and why

The `maps-kit/` folder was ported in Phase 0 and then deleted from the repo. Kept for reference:

- `README.md` — the kit's inventory (original Speak paths).
- `migrations-reference/` — Speak's migrations, verbatim. The live schema is `supabase/migrations/` (one baseline
  with the function bodies and RLS policies ported); these show where each piece came from.
- `e2e-flows/` — Speak's browser flows (walkie, walkie-ios, walkie-robust, walkie-hub, walkie-reconnect, nearby,
  micsession, ptt). They drive Speak's screens; Phase 3 rewrites them for this app's screens and seed
  (`tests/e2e/seed.sql`) and moves them back into `tests/e2e/`.
- `rt-probe/` — a throw-away Cloudflare Worker that checks the REAL Supabase Realtime private-channel path with two
  test users (binary pieces + presence). For the manual Realtime check in Phase 3.

The lessons (26 iPhone bugs) are in `docs/LESSONS.md`; the product brief is `docs/BRIEF.md`.
