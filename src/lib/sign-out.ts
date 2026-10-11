import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { stopTracking } from "@/lib/location/tracker";
import { walkieHub } from "@/lib/walkie/hub";

/** Close every live channel, stop sending the position, end the session, forget cached data. */
export async function signOut(qc: QueryClient) {
  walkieHub.setUser(null);
  await stopTracking();
  await supabase.auth.signOut();
  qc.clear();
}
