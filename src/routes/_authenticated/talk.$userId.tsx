import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Volume2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/app-header";
import { Switch } from "@/components/ui/switch";
import { useWalkieList } from "@/components/walkie/walkie-hub";
import { UserAvatar } from "@/components/user-avatar";
import { VoiceIcon } from "@/components/voice/voice-icon";
import { HistoryRow } from "@/components/walkie/history-row";
import { useAuth } from "@/hooks/use-auth";
import { useWalkie } from "@/hooks/use-walkie";
import { formatClock } from "@/lib/audio";
import { friendKeys, profileStats } from "@/lib/friends";
import { WALKIE_MAX_MS } from "@/lib/walkie/engine";
import { notificationKeys } from "@/lib/notifications";
import { setWalkieChannel, walkieAudio, walkieHistory, walkieKeys, walkieSeen } from "@/lib/walkie/history";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/talk/$userId")({
  component: TalkPage,
});

/**
 * Walkie-talkie with one friend (like Zello): hold the big button and speak — they hear you live while you talk.
 * One speaker at a time. The last 24 h can be replayed below.
 */
function TalkPage() {
  const { userId } = Route.useParams();
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();

  const other = useQuery({
    queryKey: ["profile", userId],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id, username, full_name, avatar_path").eq("id", userId).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const stats = useQuery({ queryKey: friendKeys.stats(userId), queryFn: () => profileStats(userId) });
  const friends = !!stats.data?.i_follow && !!stats.data?.follows_me;
  const history = useQuery({ queryKey: walkieKeys.history(userId), queryFn: () => walkieHistory(userId), enabled: friends });

  // Opening the screen (and every new transmission while it is open) counts as heard.
  const seen = () =>
    void walkieSeen(userId).then(() => {
      void qc.invalidateQueries({ queryKey: walkieKeys.list });
      void qc.invalidateQueries({ queryKey: notificationKeys.all });
    });
  useEffect(() => {
    if (friends) seen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friends, userId]);
  const w = useWalkie(friends ? user?.id : undefined, userId, {
    onSaved: () => {
      void qc.invalidateQueries({ queryKey: walkieKeys.history(userId) });
      seen();
    },
    onYield: () => toast(t("walkie.yielded", { name: first })),
  });
  const list = useWalkieList(friends);
  const channelOn = !!list.data?.find((c) => c.user_id === userId)?.channel_on;
  const channel = useMutation({
    mutationFn: (on: boolean) => setWalkieChannel(userId, on),
    onError: (e) => toast.error(e instanceof Error && e.message.includes("too_many") ? t("walkie.tooMany") : t("errors.generic")),
    onSettled: () => void qc.invalidateQueries({ queryKey: walkieKeys.list }),
  });
  const s = w.snap;
  const name = other.data ? other.data.full_name || other.data.username : "";
  const first = name.split(" ")[0];

  // Press → talk, release → stop; a release that comes while the mic is still starting stops it right after.
  const held = useRef(false);
  const [denied, setDenied] = useState(false);
  async function down(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 || held.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    held.current = true;
    if (s?.peerTalking) {
      setDenied(true);
      setTimeout(() => setDenied(false), 900);
      return;
    }
    const ok = await w.press();
    if (ok && !held.current) w.release();
    else if (!ok && !held.current) toast(t("walkie.holdForBeep")); // let go before the mic was ready
  }
  function up() {
    if (!held.current) return;
    held.current = false;
    w.release();
  }

  const status = !friends
    ? stats.data
      ? t("walkie.friendsOnly")
      : ""
    : !s || !s.connected
      ? s?.error === "channel"
        ? t("walkie.cantConnect")
        : t("walkie.connecting")
      : s.talking
        ? t("walkie.onAir")
        : s.starting
          ? t("walkie.starting")
          : s.peerTalking
            ? t("walkie.peerTalking", { name: first })
            : s.peerOnline
              ? t("walkie.peerHere", { name: first })
              : t("walkie.peerAway", { name: first });

  const disabled = !friends || !s?.connected;
  return (
    <>
      <AppHeader back title={t("walkie.title")} />
      <div className="flex flex-1 select-none flex-col items-center px-4 pb-8 pt-4">
        <div className="relative">
          <span
            className={cn(
              "block rounded-full p-1 ring-4 transition-colors",
              s?.peerTalking ? "animate-pulse ring-live" : s?.peerOnline ? "ring-success/70" : "ring-transparent",
            )}
          >
            <UserAvatar name={name} path={other.data?.avatar_path ?? null} size={96} />
          </span>
          {s?.peerTalking && (
            <span className="absolute -bottom-2 left-1/2 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full bg-live text-destructive-foreground">
              <VoiceIcon className="h-4 w-4" live />
            </span>
          )}
        </div>
        <h1 className="mt-4 text-display font-semibold">{name}</h1>
        <p className={cn("mt-1 h-5 text-caption", s?.peerTalking || s?.talking ? "font-semibold text-live" : "text-muted-foreground")}>{status}</p>

        {friends && s?.audioLocked && (
          <button
            type="button"
            onClick={w.unlockAudio}
            className="mt-4 flex h-10 items-center gap-2 rounded-xl bg-secondary px-4 text-caption font-semibold"
          >
            <Volume2 className="h-4 w-4" /> {t("walkie.enableSound")}
          </button>
        )}

        <div className="relative mt-10 grid h-52 w-52 place-items-center">
          {s?.talking && (
            <svg className="pointer-events-none absolute inset-0 -rotate-90" viewBox="0 0 208 208" aria-hidden>
              <circle
                cx="104" cy="104" r="100" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="text-live"
                strokeDasharray={2 * Math.PI * 100} strokeDashoffset={2 * Math.PI * 100 * (1 - Math.min(1, s.elapsedMs / WALKIE_MAX_MS))}
              />
            </svg>
          )}
          <button
            type="button"
            disabled={disabled}
            onPointerDown={(e) => void down(e)}
            onPointerUp={up}
            onPointerCancel={up}
            onLostPointerCapture={up}
            onContextMenu={(e) => e.preventDefault()}
            style={{ WebkitTouchCallout: "none", touchAction: "none" }}
            aria-label={t("walkie.hold")}
            className={cn(
              "grid h-44 w-44 place-items-center rounded-full transition-transform duration-150 disabled:opacity-40",
              s?.talking || s?.starting
                ? "scale-105 bg-live text-destructive-foreground"
                : s?.peerTalking
                  ? "bg-secondary text-muted-foreground"
                  : "bg-primary text-primary-foreground",
              denied && "animate-shake",
            )}
          >
            <VoiceIcon className="h-16 w-16" strokeWidth={1.8} live={!!s?.talking} />
          </button>
        </div>
        <p className="mt-4 h-5 text-caption tabular-nums text-muted-foreground">
          {s?.talking ? `${formatClock(s.elapsedMs)} / ${formatClock(WALKIE_MAX_MS)}` : friends ? t("walkie.hold") : ""}
        </p>

        {friends && (
          <label className="mt-8 flex w-full items-center justify-between gap-3 rounded-2xl bg-card px-4 py-3">
            <span>
              <span className="block text-callout font-semibold">{t("walkie.channelOn")}</span>
              <span className="block text-caption text-muted-foreground">{t("walkie.channelOnHint")}</span>
            </span>
            <Switch checked={channelOn} disabled={channel.isPending} onCheckedChange={(on) => channel.mutate(on)} />
          </label>
        )}

        {friends && (
          <section className="mt-6 w-full">
            <h2 className="pb-2 text-callout font-semibold text-muted-foreground">{t("walkie.last24h")}</h2>
            {history.data && !history.data.length && <p className="py-4 text-caption text-muted-foreground">{t("walkie.noHistory")}</p>}
            <ul className="divide-y divide-border">
              {(history.data ?? []).map((m) => (
                <HistoryRow key={m.id} item={m} mine={m.sender_id === user?.id} name={first} locale={i18n.language} load={walkieAudio} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
