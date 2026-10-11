import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendKeys } from "@/lib/friends";

/** Accounts without the 18+ declaration (the server refuses every RPC until then): confirm, or sign out. */
export function AgeGate({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("confirm_age");
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: friendKeys.me }),
    onError: () => toast.error(t("errors.generic")),
  });
  return (
    <main className="safe-top mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-display">{t("auth.ageGateTitle")}</h1>
      <p className="text-callout text-muted-foreground">{t("auth.ageGateText")}</p>
      <button type="button" disabled={confirm.isPending} onClick={() => confirm.mutate()} className="h-12 rounded-full bg-primary font-semibold text-primary-foreground disabled:opacity-50">
        {t("auth.ageGateConfirm")}
      </button>
      <button type="button" onClick={onSignOut} className="h-12 rounded-full bg-secondary font-semibold">
        {t("auth.signOut")}
      </button>
    </main>
  );
}
