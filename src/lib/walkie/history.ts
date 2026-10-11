import { supabase } from "@/integrations/supabase/client";

/** A saved walkie transmission (kept 24 h). */
export interface WalkieItem {
  id: string;
  sender_id: string;
  duration_ms: number;
  created_at: string;
}

export const walkieKeys = {
  all: ["walkie"] as const,
  history: (peer: string) => ["walkie", "history", peer] as const,
  list: ["walkie", "list"] as const,
};

/** A friend on the walkie screen: channel kept open or not, last transmission (24 h), how many you haven't heard. */
export interface WalkieContact {
  user_id: string;
  username: string;
  full_name: string;
  avatar_path: string | null;
  channel_on: boolean;
  last_at: string | null;
  unheard: number;
}

export async function walkieList(): Promise<WalkieContact[]> {
  const { data, error } = await supabase.rpc("walkie_list");
  if (error) throw new Error(error.message);
  return (data ?? []) as WalkieContact[];
}

/** Keep a friend's channel open while you use the app (max 10: error `too_many_channels`). */
export async function setWalkieChannel(peer: string, on: boolean) {
  const { error } = await supabase.rpc("walkie_set_channel", { p_peer: peer, p_on: on });
  if (error) throw new Error(error.message);
}

/** You looked at a friend's walkie: nothing unheard, their walkie notice read. */
export async function walkieSeen(peer: string) {
  await supabase.rpc("walkie_seen", { p_peer: peer });
}

export async function walkieHistory(peer: string): Promise<WalkieItem[]> {
  const { data, error } = await supabase.rpc("walkie_history", { p_other: peer, p_limit: 50 });
  if (error) throw new Error(error.message);
  return (data ?? []) as WalkieItem[];
}

export async function walkieAudio(id: string): Promise<{ mime: string; audio_b64: string }> {
  const { data, error } = await supabase.rpc("walkie_audio", { p_id: id });
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0];
  if (!row) throw new Error("not_available");
  return row;
}
