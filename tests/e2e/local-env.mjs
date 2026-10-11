// Prints the env for a local build / preview against the local stack: the anon key is a JWT signed with the local
// dev secret (tests/e2e/pgrst/postgrest.conf) — a test value, not a credential.
import { jwt } from "./local-supabase.mjs";
const anon = jwt({ role: "anon" }, 365 * 86400);
console.log(`VITE_SUPABASE_URL=http://127.0.0.1:54321\nVITE_SUPABASE_PUBLISHABLE_KEY=${anon}\nSUPABASE_URL=http://127.0.0.1:54321\nSUPABASE_PUBLISHABLE_KEY=${anon}`);
