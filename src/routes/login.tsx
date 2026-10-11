import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AuthFrame, Field } from "@/components/auth-form";
import { supabase } from "@/integrations/supabase/client";
import { authErrorKey } from "@/lib/auth-errors";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) return void toast.error(t(authErrorKey(error)));
    void navigate({ to: "/map", replace: true });
  }

  return (
    <AuthFrame
      title={t("auth.signInTitle")}
      tagline={t("auth.tagline")}
      onSubmit={submit}
      footer={
        <>
          {t("auth.noAccount")}{" "}
          <Link to="/signup" className="font-semibold text-link">
            {t("auth.signUp")}
          </Link>
        </>
      }
    >
      <Field label={t("auth.email")} type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <Field label={t("auth.password")} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit" disabled={busy || !email || !password} className="h-12 w-full rounded-full bg-primary font-semibold text-primary-foreground disabled:opacity-50">
        {t("auth.signIn")}
      </button>
    </AuthFrame>
  );
}
