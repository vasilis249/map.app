import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AuthFrame, Field } from "@/components/auth-form";
import { supabase } from "@/integrations/supabase/client";
import { authErrorKey } from "@/lib/auth-errors";
import { authRedirectUrl } from "@/lib/native";

export const Route = createFileRoute("/signup")({
  component: SignupPage,
});

const USERNAME = /^[a-z0-9._]{3,20}$/;

/** Email + password; name and username go to the profile (the server makes a unique username if it's taken). */
function SignupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [adult, setAdult] = useState(false);

  const userOk = !username || USERNAME.test(username);
  const valid = fullName.trim().length > 0 && fullName.trim().length <= 60 && userOk && /.+@.+\..+/.test(email.trim()) && password.length >= 8 && adult;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { full_name: fullName.trim(), age_confirmed: true, ...(username ? { username } : {}) },
        emailRedirectTo: authRedirectUrl("/login"),
      },
    });
    setBusy(false);
    if (error) return void toast.error(t(authErrorKey(error)));
    if (data.session) void navigate({ to: "/map", replace: true });
    else setSent(true); // email confirmation is on
  }

  return (
    <AuthFrame
      title={t("auth.signUpTitle")}
      tagline={t("auth.tagline")}
      onSubmit={submit}
      footer={
        <>
          {t("auth.haveAccount")}{" "}
          <Link to="/login" className="font-semibold text-link">
            {t("auth.signIn")}
          </Link>
        </>
      }
    >
      {sent ? (
        <p role="status" className="rounded-2xl bg-card p-4 text-callout">
          {t("auth.checkEmail")}
        </p>
      ) : (
        <>
          <Field label={t("auth.fullName")} autoComplete="name" maxLength={60} required value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <Field
            label={t("auth.username")}
            autoComplete="username"
            autoCapitalize="none"
            maxLength={20}
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ""))}
            hint={userOk ? undefined : t("rpcErrors.usernameFormat")}
          />
          <Field label={t("auth.email")} type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field
            label={t("auth.password")}
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={t("auth.passwordHint")}
          />
          <label className="flex items-start gap-3 rounded-2xl bg-card p-3 text-callout">
            <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-current" />
            <span>
              <span className="block font-semibold">{t("auth.age18")}</span>
              <span className="block text-caption text-muted-foreground">{t("auth.age18Why")}</span>
            </span>
          </label>
          <button type="submit" disabled={busy || !valid} className="h-12 w-full rounded-full bg-primary font-semibold text-primary-foreground disabled:opacity-50">
            {t("auth.signUp")}
          </button>
          <p className="text-center text-caption text-muted-foreground">
            {t("legal.agreeStart")}{" "}
            <Link to="/terms" className="font-semibold text-link">
              {t("legal.agreeTerms")}
            </Link>{" "}
            {t("legal.agreeAnd")}{" "}
            <Link to="/privacy" className="font-semibold text-link">
              {t("legal.agreePrivacy")}
            </Link>
            .
          </p>
        </>
      )}
    </AuthFrame>
  );
}
