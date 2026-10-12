import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { removeAvatars } from "@/lib/avatar";
import { stopTracking } from "@/lib/location/tracker";
import { stopNav } from "@/lib/nav/session";
import { walkieHub } from "@/lib/walkie/hub";

/**
 * Delete my account for good (App Store 5.1.1(v)): my photos (Storage API — SQL can't delete storage files), then
 * everything else in one database call (delete_my_account cascades), then forget the session on this device.
 * The photos are best effort: a failure there must not keep anyone from deleting their account.
 */
export async function deleteMyAccount(userId: string, qc: QueryClient) {
  await removeAvatars(userId).catch(() => undefined);
  const { error } = await supabase.rpc("delete_my_account");
  if (error) throw new Error(error.message);
  stopNav();
  walkieHub.setUser(null);
  await stopTracking().catch(() => undefined);
  // The account no longer exists on the server: only clear this device.
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  qc.clear();
}
