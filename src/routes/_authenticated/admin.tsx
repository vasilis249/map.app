import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { Segmented } from "@/components/segmented";
import { UserAvatar } from "@/components/user-avatar";
import { base64ToBlob, player } from "@/lib/audio";
import { adminReports, amIAdmin, moderationKeys, reportAudio, resolveReport, setDisabled, type AdminReport } from "@/lib/moderation";
import { timeAgoShort } from "@/lib/time-ago";

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminPage,
});

/**
 * Moderation queue (admins only — the server checks every call). Open reports newest first, with how many open
 * reports the person has; hear a reported transmission; dismiss, or disable the account (closes all their reports).
 * The resolved tab lists past decisions; a disabled account can be enabled again there.
 */
function AdminPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const admin = useQuery({ queryKey: moderationKeys.admin, queryFn: amIAdmin });
  const queue = useQuery({ queryKey: moderationKeys.queue(open), queryFn: () => adminReports(open), enabled: !!admin.data });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["moderation"] });
  const resolve = useMutation({
    mutationFn: ({ r, action }: { r: AdminReport; action: "dismiss" | "disable" }) => resolveReport(r.id, action),
    onSuccess: (_d, v) => toast(t(v.action === "dismiss" ? "admin.dismissed" : "admin.disabled")),
    onError: () => toast.error(t("errors.generic")),
    onSettled: refresh,
  });
  const enable = useMutation({
    mutationFn: (user: string) => setDisabled(user, false),
    onSuccess: () => toast(t("admin.enabled")),
    onError: () => toast.error(t("errors.generic")),
    onSettled: refresh,
  });
  async function listen(r: AdminReport) {
    player.prime(); // inside the tap (iOS)
    try {
      const a = await reportAudio(r.id);
      await player.play(base64ToBlob(a.audio_b64, a.mime));
    } catch {
      toast.error(t("voice.playFailed"));
    }
  }

  if (admin.data === false) return <AppHeader back title={t("admin.title")} />;
  return (
    <>
      <AppHeader back title={t("admin.title")} />
      <div className="space-y-3 px-4 pb-8">
        <Segmented value={open} onChange={setOpen} options={[{ value: true, label: t("admin.open") }, { value: false, label: t("admin.resolved") }]} />
        {queue.data && !queue.data.length && <p className="py-10 text-center text-callout text-muted-foreground">{t("admin.empty")}</p>}
        <ul className="space-y-3">
          {(queue.data ?? []).map((r) => (
            <li key={r.id} className="rounded-2xl bg-card p-4" aria-label={`report ${r.target_username}`}>
              <div className="flex items-center gap-3">
                <UserAvatar name={r.target_full_name || r.target_username} path={r.target_avatar_path} size={44} />
                <div className="min-w-0 flex-1">
                  <Link to="/u/$username" params={{ username: r.target_username }} className="block truncate font-semibold">
                    {r.target_full_name || r.target_username} <span className="font-normal text-muted-foreground">@{r.target_username}</span>
                  </Link>
                  <p className="text-caption text-muted-foreground">
                    {t(`admin.kind.${r.kind}`)} · {t(`report.reasons.${r.reason}`, { defaultValue: r.reason || "—" })} · {timeAgoShort(r.created_at, i18n.language)}
                    {r.reporter_username ? ` · @${r.reporter_username}` : ""}
                  </p>
                  <p className="text-caption">
                    {t("admin.openReports", { count: r.target_open_reports })}
                    {r.target_disabled ? ` · ${t("admin.isDisabled")}` : ""}
                    {r.resolution ? ` · ${t(`admin.resolution.${r.resolution}`)}` : ""}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {r.has_audio && (
                  <button type="button" onClick={() => void listen(r)} className="flex h-10 items-center gap-1.5 rounded-full bg-secondary px-4 text-caption font-semibold">
                    <Play className="h-4 w-4" /> {t("admin.listen")}
                  </button>
                )}
                {!r.resolved_at && (
                  <>
                    <button
                      type="button"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ r, action: "dismiss" })}
                      className="h-10 rounded-full bg-secondary px-4 text-caption font-semibold disabled:opacity-60"
                    >
                      {t("admin.dismiss")}
                    </button>
                    <button
                      type="button"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ r, action: "disable" })}
                      className="h-10 rounded-full bg-destructive px-4 text-caption font-semibold text-destructive-foreground disabled:opacity-60"
                    >
                      {t("admin.disable")}
                    </button>
                  </>
                )}
                {r.resolved_at && r.target_disabled && (
                  <button
                    type="button"
                    disabled={enable.isPending}
                    onClick={() => enable.mutate(r.target_user_id)}
                    className="h-10 rounded-full bg-secondary px-4 text-caption font-semibold disabled:opacity-60"
                  >
                    {t("admin.enable")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
