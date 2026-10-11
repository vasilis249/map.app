/** Supabase Auth error → i18n key (never show raw server messages). */
export function authErrorKey(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  const code = err?.code ?? "";
  const msg = (err?.message ?? "").toLowerCase();
  if (code === "invalid_credentials" || msg.includes("invalid login")) return "auth.badCredentials";
  if (code === "email_not_confirmed" || msg.includes("not confirmed")) return "auth.emailNotConfirmed";
  if (code === "weak_password" || msg.includes("password should")) return "auth.weakPassword";
  if (code === "user_already_exists" || code === "email_exists" || msg.includes("already registered")) return "auth.emailTaken";
  if (code === "email_address_invalid" || code === "validation_failed" || msg.includes("invalid email")) return "auth.invalidEmail";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit") return "rpcErrors.rateLimited";
  if (msg.includes("failed to fetch") || msg.includes("network")) return "errors.offline";
  return "errors.generic";
}
