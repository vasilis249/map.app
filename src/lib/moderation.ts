import { supabase } from "@/integrations/supabase/client";

/** A report in the admin queue (admin_reports). */
export interface AdminReport {
  id: string;
  created_at: string;
  kind: "user" | "walkie" | "nearby";
  reason: string;
  target_id: string | null;
  resolved_at: string | null;
  resolution: "dismissed" | "disabled" | null;
  reporter_id: string | null;
  reporter_username: string | null;
  target_user_id: string;
  target_username: string;
  target_full_name: string;
  target_avatar_path: string | null;
  target_disabled: boolean;
  target_open_reports: number;
  has_audio: boolean;
}

export const moderationKeys = {
  admin: ["moderation", "admin"] as const,
  queue: (open: boolean) => ["moderation", "queue", open] as const,
};

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

/** Is the signed-in user an admin? (only decides whether the screen is shown; every RPC checks again) */
export async function amIAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc("am_i_admin");
  fail(error);
  return !!data;
}

export async function adminReports(open: boolean): Promise<AdminReport[]> {
  const { data, error } = await supabase.rpc("admin_reports", { p_open: open, p_limit: 100 });
  fail(error);
  return (data ?? []) as AdminReport[];
}

export async function resolveReport(id: string, action: "dismiss" | "disable") {
  fail((await supabase.rpc("admin_resolve_report", { p_report: id, p_action: action })).error);
}

export async function setDisabled(user: string, disabled: boolean) {
  fail((await supabase.rpc("admin_set_disabled", { p_user: user, p_disabled: disabled })).error);
}

export async function reportAudio(id: string): Promise<{ mime: string; audio_b64: string }> {
  const { data, error } = await supabase.rpc("admin_report_audio", { p_report: id });
  fail(error);
  const row = (data ?? [])[0];
  if (!row) throw new Error("not_available");
  return row;
}
