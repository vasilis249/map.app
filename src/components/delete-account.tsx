import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { useAuth } from "@/hooks/use-auth";
import { deleteMyAccount } from "@/lib/account";

/**
 * "Delete account" (App Store 5.1.1(v)): a quiet button, then a sheet that says exactly what goes, and one clear
 * confirmation. Also offered where an account is stuck (suspended, or the 18+ gate).
 */
export function DeleteAccount() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (!user) return;
    setBusy(true);
    try {
      await deleteMyAccount(user.id, qc);
      toast(t("account.deleted"));
      void navigate({ to: "/login", replace: true });
    } catch {
      toast.error(t("errors.generic"));
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="h-12 w-full rounded-full text-callout font-semibold text-destructive">
        {t("account.delete")}
      </button>
      <Drawer open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DrawerContent>
          <div className="px-5 pb-8 pt-3">
            <DrawerTitle className="text-tagline font-semibold">{t("account.deleteTitle")}</DrawerTitle>
            <DrawerDescription className="mt-2 text-callout leading-snug text-muted-foreground">{t("account.deleteText")}</DrawerDescription>
            <div className="mt-5 grid gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirm()}
                className="h-12 rounded-full bg-destructive font-semibold text-white disabled:opacity-60"
              >
                {t("account.deleteConfirm")}
              </button>
              <button type="button" disabled={busy} onClick={() => setOpen(false)} className="h-12 rounded-full bg-secondary font-semibold">
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
