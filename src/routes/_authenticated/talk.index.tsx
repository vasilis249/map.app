import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { RadioTower } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { EmptyState } from "@/components/empty-state";
import { UserAvatar } from "@/components/user-avatar";
import { Switch } from "@/components/ui/switch";
import { useWalkieList } from "@/components/walkie/walkie-hub";
import { isNativeApp } from "@/lib/native";
import { requestNotifyPermission } from "@/lib/local-notify";
import { timeAgoShort } from "@/lib/time-ago";
import { setWalkieChannel, walkieKeys, type WalkieContact } from "@/lib/walkie/history";
import { walkieHub } from "@/lib/walkie/hub";
import { backgroundWanted, setBackgroundWanted } from "@/lib/walkie/keepalive";
import { unlockWalkieAudio } from "@/lib/walkie/engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/talk/")({
  component: WalkieListPage,
});

/**
 * Walkie-talkie friends: open a friend's channel to hear them live anywhere in the app (max 10), see who is here,
 * what you haven't heard (24 h). Tap a friend to talk.
 */
function WalkieListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useWalkieList();
  useSyncExternalStore(walkieHub.subscribe, walkieHub.version, walkieHub.version);
  const online = new Set(walkieHub.peers().filter((p) => p.kind === "walkie" && p.snap.peerOnline).map((p) => p.peer));
  const [background, setBackground] = useState(backgroundWanted);

  const toggle = useMutation({
    mutationFn: ({ peer, on }: { peer: string; on: boolean }) => setWalkieChannel(peer, on),
    onMutate: async ({ peer, on }) => {
      // In the tap: sound on (iOS) and, in the app, ask once for notices while in the background.
      if (on) {
        void unlockWalkieAudio();
        if (isNativeApp()) void requestNotifyPermission();
      }
      await qc.cancelQueries({ queryKey: walkieKeys.list });
      qc.setQueryData<WalkieContact[]>(walkieKeys.list, (old) => old?.map((c) => (c.user_id === peer ? { ...c, channel_on: on } : c)));
    },
    onError: (e) => toast.error(e instanceof Error && e.message.includes("too_many") ? t("walkie.tooMany") : t("errors.generic")),
    onSettled: () => void qc.invalidateQueries({ queryKey: walkieKeys.list }),
  });

  const anyOn = (list.data ?? []).some((c) => c.channel_on);
  return (
    <>
      <AppHeader back title={t("walkie.title")} />
      {list.data && !list.data.length ? (
        <EmptyState
          icon={RadioTower}
          title={t("walkie.emptyTitle")}
          text={t("walkie.empty")}
          action={
            <Link to="/search" className="inline-flex h-12 items-center rounded-xl bg-primary px-8 font-semibold text-primary-foreground">
              {t("walkie.findPeople")}
            </Link>
          }
        />
      ) : (
        <div className="px-4 pb-6">
          <p className="pb-2 pt-1 text-caption text-muted-foreground">{t("walkie.listHint")}</p>
          <ul>
            {(list.data ?? []).map((c) => {
              const name = c.full_name || c.username;
              const sub = c.unheard
                ? t("walkie.unheard", { count: c.unheard })
                : c.last_at
                  ? timeAgoShort(c.last_at, i18n.language)
                  : online.has(c.user_id)
                    ? t("walkie.here")
                    : "";
              return (
                <li key={c.user_id} className="flex items-center gap-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => void navigate({ to: "/talk/$userId", params: { userId: c.user_id } })}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className={cn("rounded-full p-0.5 ring-2", online.has(c.user_id) ? "ring-success/80" : "ring-transparent")}>
                      <UserAvatar name={name} path={c.avatar_path} size={52} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-semibold">{name}</span>
                      {sub && <span className={cn("block truncate text-caption", c.unheard ? "font-semibold text-live" : "text-muted-foreground")}>{sub}</span>}
                    </span>
                  </button>
                  <label className="flex shrink-0 flex-col items-center gap-1 text-[11px] text-muted-foreground">
                    <Switch
                      checked={c.channel_on}
                      onCheckedChange={(on) => toggle.mutate({ peer: c.user_id, on })}
                      aria-label={t("walkie.channelOn")}
                    />
                    {t("walkie.channelShort")}
                  </label>
                </li>
              );
            })}
          </ul>
          {isNativeApp() && anyOn && (
            <label className="mt-4 flex items-start justify-between gap-3 rounded-2xl bg-card px-4 py-3">
              <span>
                <span className="block text-callout font-semibold">{t("walkie.background")}</span>
                <span className="block text-caption text-muted-foreground">{t("walkie.backgroundHint")}</span>
              </span>
              <Switch
                checked={background}
                onCheckedChange={(on) => {
                  setBackgroundWanted(on);
                  setBackground(on);
                }}
              />
            </label>
          )}
        </div>
      )}
    </>
  );
}
