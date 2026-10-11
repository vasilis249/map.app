import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { isNativeApp } from "@/lib/native";

function createSupabaseClient() {
  // Client: Vite build-time replacement. Server (SSR shell): the Worker's environment.
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || (typeof process !== "undefined" ? process.env.SUPABASE_URL : undefined);
  const SUPABASE_PUBLISHABLE_KEY =
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || (typeof process !== "undefined" ? process.env.SUPABASE_PUBLISHABLE_KEY : undefined);

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    const missing = [...(!SUPABASE_URL ? ["SUPABASE_URL"] : []), ...(!SUPABASE_PUBLISHABLE_KEY ? ["SUPABASE_PUBLISHABLE_KEY"] : [])];
    const message = `Missing Supabase environment variable(s): ${missing.join(", ")} (see .env.example).`;
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: typeof window !== "undefined" ? localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
      // The iOS app receives auth email links through a custom URL scheme; PKCE
      // keeps the tokens out of that URL (a code is useless without the verifier).
      flowType: isNativeApp() ? "pkce" : "implicit",
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
