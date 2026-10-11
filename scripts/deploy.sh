#!/bin/bash
# Build and deploy the web app (Cloudflare Workers). Refuses a bundle without the Supabase URL / publishable key or
# with a service-role key in it (scripts/check-bundle.mjs). Reads .env when present (see .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${VITE_SUPABASE_URL:?set VITE_SUPABASE_URL (.env)}"
: "${VITE_SUPABASE_PUBLISHABLE_KEY:?set VITE_SUPABASE_PUBLISHABLE_KEY (.env)}"
rm -rf dist
npx vite build
node scripts/check-bundle.mjs
npx wrangler deploy
