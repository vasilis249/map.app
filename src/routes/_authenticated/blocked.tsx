import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { UserAvatar } from "@/components/user-avatar";
import { friendKeys, listBlocked, rpcErrorKey, unblockUser } from "@/lib/friends";

export const Route = createFileRoute("/_authenticated/blocked")({
  component: BlockedPage,
});

/** People you blocked (they don't see you anywhere, nor you them). Unblocking doesn't restore follows. */
function BlockedPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: friendKeys.blocked, queryFn: listBlocked });
  const unblock = useMutation({
    mutationFn: unblockUser,
    onSuccess: () => {
      toast(t("blocked.done"));
      void qc.invalidateQueries({ queryKey: friendKeys.all });
      void qc.invalidateQueries({ queryKey: ["location"] });
    },
    onError: (e) => toast.error(t(rpcErrorKey(e))),
  });
  return (
    <>
      <AppHeader back title={t("blocked.title")} />
      <div className="px-4">
        {list.data && !list.data.length && <p className="py-10 text-center text-callout text-muted-foreground">{t("blocked.empty")}</p>}
        <ul>
          {(list.data ?? []).map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2">
              <UserAvatar name={p.full_name || p.username} path={p.avatar_path} size={46} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{p.full_name || p.username}</span>
                <span className="block truncate text-caption text-muted-foreground">@{p.username}</span>
              </span>
              <button
                type="button"
                disabled={unblock.isPending}
                onClick={() => unblock.mutate(p.id)}
                className="h-9 rounded-full bg-secondary px-4 text-caption font-semibold disabled:opacity-60"
              >
                {t("blocked.unblock")}
              </button>
            </li>
          ))}
        </ul>
        <p className="py-4 text-caption text-muted-foreground">{t("blocked.hint")}</p>
      </div>
    </>
  );
}
