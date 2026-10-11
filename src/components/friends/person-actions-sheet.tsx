import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Ban, ChevronRight, Flag } from "lucide-react";
import { toast } from "sonner";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { UserAvatar } from "@/components/user-avatar";
import {
  blockUser,
  friendKeys,
  REPORT_REASONS,
  reportContent,
  rpcErrorKey,
  type Person,
  type ReportKind,
} from "@/lib/friends";

type Step = "menu" | "reasons" | "reported" | "confirmBlock";

/**
 * Secondary actions for a person (App Store guideline 1.2): report with a reason — the
 * person, or a specific saved transmission via `report` — optionally block right after, or
 * block (confirmed inside the sheet).
 */
export function PersonActionsSheet({
  person,
  report,
  onOpenChange,
  onBlocked,
}: {
  person: Pick<Person, "id" | "username" | "full_name" | "avatar_path"> | null;
  /** What "Report" refers to; defaults to the person. */
  report?: { kind: ReportKind; id: string; label: string };
  onOpenChange: (open: boolean) => void;
  onBlocked?: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("menu");
  useEffect(() => setStep("menu"), [person?.id, report?.id]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: friendKeys.all });
    void qc.invalidateQueries({ queryKey: ["walkie"] });
    void qc.invalidateQueries({ queryKey: ["nearby"] });
    void qc.invalidateQueries({ queryKey: ["location"] });
    void qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  const sendReport = useMutation({
    mutationFn: (reason: string) => reportContent(report?.kind ?? "user", report?.id ?? person!.id, reason),
    onSuccess: () => setStep("reported"),
    onError: (e) => toast.error(t(rpcErrorKey(e))),
  });

  const act = useMutation({
    mutationFn: () => blockUser(person!.id),
    onSuccess: () => {
      refresh();
      toast.success(t("friends.done.block"));
      onOpenChange(false);
      onBlocked?.();
    },
    onError: (e) => toast.error(t(rpcErrorKey(e))),
  });

  const row = "flex w-full items-center gap-3 px-4 py-3.5 text-body font-normal disabled:opacity-50";
  const name = person ? person.full_name || person.username : "";
  const busy = sendReport.isPending || act.isPending;

  return (
    <Drawer open={!!person} onOpenChange={onOpenChange}>
      <DrawerContent className="mx-auto max-h-[92vh] max-w-lg">
        <DrawerTitle className="sr-only">{name}</DrawerTitle>
        <DrawerDescription className="sr-only">{t("friends.actions")}</DrawerDescription>
        {person && (
          <div className="safe-bottom overflow-y-auto p-4">
            <div className="mb-4 flex flex-col items-center gap-2 text-center">
              <UserAvatar name={name} path={person.avatar_path} size={72} />
              <p className="text-body font-semibold">{name}</p>
              <p className="-mt-2 text-caption text-muted-foreground">{person.username}</p>
            </div>

            {step === "menu" && (
              <div className="divide-y divide-border overflow-hidden rounded-2xl bg-group">
                <button type="button" className={row} onClick={() => setStep("reasons")}>
                  <Flag className="h-5 w-5" /> {report?.label ?? t("friends.report")}
                </button>
                <button type="button" className={`${row} text-destructive`} onClick={() => setStep("confirmBlock")}>
                  <Ban className="h-5 w-5" /> {t("friends.block")}
                </button>
              </div>
            )}

            {step === "reasons" && (
              <>
                <p className="mb-3 text-center text-caption font-semibold">{t("report.why")}</p>
                <div className="divide-y divide-border overflow-hidden rounded-2xl bg-group">
                  {REPORT_REASONS.map((r) => (
                    <button key={r} type="button" disabled={busy} className={`${row} justify-between`} onClick={() => sendReport.mutate(r)}>
                      {t(`report.reasons.${r}`)}
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </>
            )}

            {step === "reported" && (
              <div className="space-y-3 text-center">
                <p className="text-body font-semibold">{t("report.thanks")}</p>
                <p className="px-4 text-caption text-muted-foreground">{t("report.review")}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act.mutate()}
                  className="h-12 w-full rounded-xl bg-destructive font-semibold text-destructive-foreground disabled:opacity-50"
                >
                  {t("report.alsoBlock")}
                </button>
                <button type="button" onClick={() => onOpenChange(false)} className="h-12 w-full rounded-xl bg-secondary font-semibold">
                  {t("report.done")}
                </button>
              </div>
            )}

            {step === "confirmBlock" && (
              <div className="space-y-3 text-center">
                <p className="px-4 text-caption text-muted-foreground">{t("friends.blockConfirm")}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act.mutate()}
                  className="h-12 w-full rounded-xl bg-destructive font-semibold text-destructive-foreground disabled:opacity-50"
                >
                  {t("friends.block")}
                </button>
                <button type="button" onClick={() => setStep("menu")} className="h-12 w-full rounded-xl bg-secondary font-semibold">
                  {t("common.cancel")}
                </button>
              </div>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
