import { supabase } from "@/integrations/supabase/client";

/** follow: X follows you · nearby: X talked to you on the map · walkie: a friend's transmission you haven't heard. */
export interface AppNotification {
  id: number;
  kind: "follow" | "nearby" | "walkie";
  created_at: string;
  read_at: string | null;
  actor: { id: string; username: string; full_name: string; avatar_path: string | null } | null;
}

export const notificationKeys = {
  all: ["notifications"] as const,
  list: ["notifications", "list"] as const,
  unread: ["notifications", "unread"] as const,
};

export async function listNotifications(): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, kind, created_at, read_at, actor:profiles!notifications_actor_id_fkey(id, username, full_name, avatar_path)")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as AppNotification[];
}

export async function unreadCount(): Promise<number> {
  const { count, error } = await supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function markAllRead() {
  const { error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
  if (error) throw new Error(error.message);
}
