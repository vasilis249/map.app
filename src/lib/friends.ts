// People: follows, search, lists, blocks, reports. (File name kept from the kit.)
import { supabase } from "@/integrations/supabase/client";

export interface Person {
  id: string;
  username: string;
  full_name: string;
  avatar_path: string | null;
  bio?: string;
  i_follow?: boolean;
  follows_me?: boolean;
}

export interface ProfileStats {
  followers: number;
  following: number;
  i_follow: boolean;
  follows_me: boolean;
}

export const friendKeys = {
  all: ["people"] as const,
  search: (q: string) => ["people", "search", q] as const,
  suggested: ["people", "suggested"] as const,
  list: (user: string, which: "followers" | "following") => ["people", "list", user, which] as const,
  stats: (user: string) => ["people", "stats", user] as const,
  byUsername: (u: string) => ["people", "profile", u] as const,
  me: ["profile", "me"] as const,
  blocked: ["people", "blocked"] as const,
};

function unwrap<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data as T;
}

export async function searchUsers(q: string): Promise<Person[]> {
  return unwrap(await supabase.rpc("search_users", { p_query: q })) ?? [];
}

export async function suggestedPeople(limit = 10): Promise<Person[]> {
  return unwrap(await supabase.rpc("suggested_people", { p_limit: limit })) ?? [];
}

/** One page of someone's followers / following (newest first). Pages are LIST_PAGE long; a shorter one is the last. */
export const LIST_PAGE = 50;
export async function followList(user: string, which: "followers" | "following", offset = 0): Promise<Person[]> {
  return unwrap(await supabase.rpc("follow_list", { p_user: user, p_which: which, p_limit: LIST_PAGE, p_offset: offset })) ?? [];
}

export async function profileStats(user: string): Promise<ProfileStats | null> {
  const rows = unwrap(await supabase.rpc("profile_stats", { p_user: user })) ?? [];
  return rows[0] ?? null;
}

export async function profileByUsername(username: string): Promise<Person | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, full_name, bio, avatar_path")
    .eq("username", username)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function setFollowing(user: string, follow: boolean) {
  unwrap(await supabase.rpc(follow ? "follow_user" : "unfollow_user", { p_user: user }));
}

export async function removeFollower(user: string) {
  unwrap(await supabase.rpc("remove_follower", { p_user: user }));
}

export async function blockUser(id: string) {
  unwrap(await supabase.rpc("block_user", { p_user: id }));
}

/** What a report is about: a person, or one of their saved transmissions to you. */
export type ReportKind = "user" | "walkie" | "nearby";
export const REPORT_REASONS = ["spam", "harassment", "hate", "sexual", "violence", "dangerous", "other"] as const;

export async function reportContent(kind: ReportKind, target: string, reason: string) {
  unwrap(await supabase.rpc("report_content", { p_kind: kind, p_target: target, p_reason: reason }));
}

export async function unblockUser(id: string) {
  unwrap(await supabase.rpc("unblock_user", { p_user: id }));
}

export async function listBlocked(): Promise<Person[]> {
  return unwrap(await supabase.rpc("my_blocked")) ?? [];
}

/** Maps the RPC error codes raised in the database to i18n keys. */
export function rpcErrorKey(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("rate_limited")) return "rpcErrors.rateLimited";
  if (msg.includes("profiles_username_key") || msg.includes("duplicate key")) return "rpcErrors.usernameTaken";
  if (msg.includes("profiles_username_check")) return "rpcErrors.usernameFormat";
  if (msg.includes("not_allowed") || msg.includes("not_friends")) return "rpcErrors.notAllowed";
  if (msg.includes("not_found") || msg.includes("not_available")) return "rpcErrors.notFound";
  return "errors.generic";
}
