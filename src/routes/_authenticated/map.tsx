import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LocateFixed, MapPin, MoreHorizontal, Navigation, RadioTower, Users } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { LiveMap, type MapFocus } from "@/components/map/live-map";
import { NearbyTalk } from "@/components/map/nearby-talk";
import { FollowButton } from "@/components/friends/follow-button";
import { PersonActionsSheet } from "@/components/friends/person-actions-sheet";
import { useHubPeers } from "@/components/walkie/walkie-hub";
import { UserAvatar } from "@/components/user-avatar";
import { useMyProfile } from "@/hooks/use-my-profile";
import { locationKeys, mapPeople, mySharing, type MapPerson } from "@/lib/location/api";
import { formatDistance } from "@/lib/location/format";
import { NEAR_M } from "@/lib/location/near";
import { forgetNearby, nearbyPerson } from "@/lib/location/nearby";
import { compassHeading, enableCompass, onCompass } from "@/lib/location/compass";
import {
  APPROXIMATE_M,
  hasNativeLocation,
  localFix,
  metres,
  onLocalFix,
  openLocationSettings,
  watchLocal,
  type LocalFix,
  type LocalProblem,
} from "@/lib/location/tracker";
import { isNativeApp } from "@/lib/native";
import { timeAgoShort } from "@/lib/time-ago";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/map")({
  validateSearch: (s: Record<string, unknown>): { u?: string } => (typeof s.u === "string" && s.u ? { u: s.u } : {}),
  component: MapPage,
});

const RADII = [50, 100, NEAR_M] as const;
type View = "friends" | "nearby";

/** Directions in Apple Maps on Apple devices, Google Maps elsewhere. */
function directionsUrl(lat: number, lng: number) {
  const apple = typeof navigator !== "undefined" && /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  return apple ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/** Your position straight from this device, live while the map is open (nothing is sent unless you share). */
function useLocalFix() {
  const [fix, setFix] = useState<LocalFix | null>(localFix);
  const [problem, setProblem] = useState<LocalProblem | null>(null);
  // The first fixes are often rough for a few seconds: only call it "approximate" once it stays so. Also: after
  // 15 s without any position, say so (instead of an endless "finding you").
  const [settled, setSettled] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setSlow(false);
    setProblem(null);
    const off = onLocalFix((f) => {
      setFix(f);
      setProblem(null);
    });
    const stop = watchLocal(setProblem);
    const timers = [setTimeout(() => setSettled(true), 8_000), setTimeout(() => setSlow(true), 15_000)];
    return () => {
      off();
      stop();
      timers.forEach(clearTimeout);
    };
  }, [attempt]);
  return { fix, problem, settled, slow, retry: () => setAttempt((a) => a + 1) };
}

/** Where the phone points (compass, once allowed from a tap). */
function useCompass() {
  const [h, setH] = useState<number | null>(compassHeading);
  useEffect(() => onCompass(setH), []);
  return h;
}

/** A position counts as "now" for 2 minutes (phones re-send once a minute while standing still). */
const FRESH_MS = 2 * 60_000;

/**
 * The map, like Snap Map / Find My. "Φίλοι": you (live, from this phone) and your friends who share, wherever they
 * are, with a strip of them at the bottom to fly to each one. "Κοντά μου": everyone sharing with everyone within
 * 50 / 100 / 200 m, whom you can talk to (push to talk). Refreshes every 5 s; distances are measured from where
 * you are right now; friends' last known positions (up to 1 h) show faded with their age, like Find My.
 * ?u=<id> opens that person's card (e.g. from the "… is talking to you" banner).
 */
function MapPage() {
  const { t, i18n } = useTranslation();
  const profile = useMyProfile();
  const sharing = useQuery({ queryKey: locationKeys.sharing, queryFn: mySharing, refetchInterval: 10_000 });
  const [view, setView] = useState<View>("friends");
  const [radius, setRadius] = useState<number>(NEAR_M);
  const on = !!sharing.data && sharing.data.mode !== "off";
  const people = useQuery({ queryKey: locationKeys.people(radius), queryFn: () => mapPeople(radius), enabled: on, refetchInterval: 5_000 });
  const { u } = Route.useSearch();
  const navigate = useNavigate({ from: "/map" });
  const [listOpen, setListOpen] = useState(false);
  // Report / block someone from their card (App Store 1.2: every place you meet people has both).
  const [actionsFor, setActionsFor] = useState<MapPerson | null>(null);
  const qc = useQueryClient();
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const move = (target: MapFocus["target"]) => setFocus((f) => ({ key: (f?.key ?? 0) + 1, target }));
  const talking = useHubPeers()
    .filter((p) => p.kind === "nearby" && p.snap.peerTalking)
    .map((p) => p.peer);
  const local = useLocalFix();
  const compass = useCompass();

  const s = sharing.data;
  // You: this phone's live position, else the last one you shared.
  const me = local.fix
    ? { lat: local.fix.lat, lng: local.fix.lng, accuracy: local.fix.accuracy, live: true }
    : on && s?.lat != null && s?.lng != null
      ? { lat: s.lat, lng: s.lng, accuracy: s.accuracy_m }
      : null;
  // Distances from where you are right now (this phone), else from your last shared position (server).
  const distOf = (p: MapPerson) => (me && (p.lat || p.lng) ? Math.round(metres(me, p)) : p.distance_m);
  const ageOf = (p: MapPerson) => (Date.now() - Date.parse(p.updated_at) > FRESH_MS ? timeAgoShort(p.updated_at, i18n.language) : null);
  const heading = compass ?? local.fix?.course ?? null;
  const approximate = local.settled && !!me?.accuracy && me.accuracy > APPROXIMATE_M;
  const list = people.data ?? [];
  const friends = list.filter((p) => p.is_friend).sort((a, b) => distOf(a) - distOf(b));
  const nearby = list.filter((p) => p.distance_m <= radius);
  const shown = view === "friends" ? friends : nearby;

  const select = (p: MapPerson | null) => {
    void navigate({ search: p ? { u: p.user_id } : {}, replace: true });
    if (p && (p.lat || p.lng)) move({ lat: p.lat, lng: p.lng });
  };
  const switchView = (v: View) => {
    if (v === view) return;
    setView(v);
    move(v === "nearby" ? "radius" : "me");
  };

  // The open card follows that person's latest position; someone who talked to you but is off your map right now
  // still gets a card (from their knock) so you can answer.
  const known = u ? nearbyPerson(u) : undefined;
  const current: MapPerson | null = u
    ? (list.find((p) => p.user_id === u) ??
      (known
        ? { ...known, lat: 0, lng: 0, accuracy_m: null, heading: null, updated_at: new Date().toISOString(), distance_m: known.distance_m ?? 0, is_friend: false, can_talk: true }
        : null))
    : null;
  // Opened for someone who isn't a friend (e.g. from the banner): the nearby view, at the full radius so they show.
  const currentIsFriend = current?.is_friend;
  useEffect(() => {
    if (!u || currentIsFriend !== false) return;
    setView("nearby");
    setRadius(NEAR_M);
  }, [u, currentIsFriend]);

  return (
    <div className="fixed inset-0 z-0 bg-background">
      <LiveMap
        me={me}
        meFace={{ name: profile.data?.full_name || profile.data?.username || "", path: profile.data?.avatar_path ?? null }}
        radius={view === "nearby" ? radius : null}
        people={shown}
        onSelect={select}
        focus={focus}
        talking={talking}
        heading={heading}
        ageOf={ageOf}
        lang={i18n.language}
      />

      {/* top: friends | nearby (+ radius) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full glass border border-border/60 shadow-float p-1" role="tablist">
          {(["friends", "nearby"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => switchView(v)}
              className={cn("h-9 rounded-full px-5 text-caption font-semibold", view === v ? "bg-primary text-primary-foreground" : "text-foreground/90")}
            >
              {t(v === "friends" ? "map.friendsTab" : "map.nearbyTab")}
            </button>
          ))}
        </div>
        {view === "nearby" && (
          <div className="pointer-events-auto flex items-center gap-1 rounded-full glass border border-border/60 shadow-float p-1">
            {RADII.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={radius === r}
                onClick={() => {
                  setRadius(r);
                  move("radius");
                }}
                className={cn("h-8 rounded-full px-3.5 text-caption font-semibold", radius === r ? "bg-segment text-foreground" : "text-foreground/85")}
              >
                {formatDistance(r, i18n.language)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* bottom (above the floating nav) */}
      <div className="absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+6.5rem)] z-10 flex flex-col gap-3 px-4">
        {me && (
          <button
            type="button"
            onClick={() => {
              move(view === "nearby" ? "radius" : "me");
              void enableCompass(); // inside the tap: iOS asks for motion access once
            }}
            aria-label={t("map.recenter")}
            className="grid h-12 w-12 place-items-center self-end rounded-full glass border border-border/60 shadow-float"
          >
            <LocateFixed className="h-5 w-5 text-link" />
          </button>
        )}

        {on && view === "friends" && (
          <div className="max-w-full self-start rounded-3xl glass border border-border/60 shadow-float p-3">
            {friends.length ? (
              <ul className="flex gap-3 overflow-x-auto px-0.5 py-1" aria-label={t("map.friendsTab")}>
                {friends.map((p) => (
                  <li key={p.user_id} className="shrink-0">
                    <button type="button" onClick={() => select(p)} className="flex w-16 flex-col items-center gap-1 text-center">
                      <span className="rounded-full p-0.5 ring-2 ring-success">
                        <UserAvatar name={p.full_name || p.username} path={p.avatar_path} size={48} />
                      </span>
                      <span className="w-full truncate text-fine font-semibold">{(p.full_name || p.username).split(" ")[0]}</span>
                      <span className="w-full truncate text-[11px] text-muted-foreground">
                        {ageOf(p) ?? formatDistance(distOf(p), i18n.language)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-1 py-1 text-caption text-muted-foreground">{t("map.noFriends")}</p>
            )}
          </div>
        )}

        {on && view === "nearby" && (
          <button
            type="button"
            onClick={() => setListOpen(true)}
            className="flex h-12 items-center gap-2 self-start rounded-full glass border border-border/60 shadow-float px-5 text-callout font-semibold"
          >
            <Users className="h-5 w-5" /> {t("map.nearby", { count: nearby.length })}
          </button>
        )}

        {/* your position is only approximate (iOS "Precise Location" off, or no GPS) */}
        {approximate && (
          <div className="rounded-3xl glass border border-border/60 shadow-float p-4">
            <p className="text-callout font-semibold">{t("map.approxTitle", { accuracy: formatDistance(me!.accuracy!, i18n.language) })}</p>
            <p className="mt-1 text-caption leading-snug text-muted-foreground">{t(isNativeApp() ? "map.approxIos" : "map.approxWeb")}</p>
            {isNativeApp() && (
              <button type="button" onClick={openLocationSettings} className="mt-2 text-caption font-semibold text-link">
                {t("location.openSettings")}
              </button>
            )}
          </div>
        )}

        {/* sharing off, or no position yet */}
        {s && !on && (
          <div className="rounded-3xl glass border border-border/60 shadow-float p-5">
            <p className="flex items-center gap-2 text-body font-semibold">
              <MapPin className="h-5 w-5 text-link" /> {t("map.offTitle")}
            </p>
            <p className="mt-1 text-callout leading-snug text-muted-foreground">{t("map.off")}</p>
            <Link to="/location" className="mt-4 flex h-12 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
              {t("map.turnOn")}
            </Link>
          </div>
        )}
        {!local.fix && (local.problem || local.slow || (s && on && !me)) && (
          <div className="rounded-3xl glass border border-border/60 shadow-float p-4">
            <p className="flex items-center gap-2 text-callout font-semibold">
              <LocateFixed className={cn("h-4 w-4 text-link", !local.problem && !local.slow && "animate-pulse")} />
              {t(local.problem === "denied" ? "map.deniedTitle" : local.problem || local.slow ? "map.notFoundTitle" : "map.waitingTitle")}
            </p>
            {(local.problem || local.slow) && (
              <>
                <p className="mt-1 text-caption leading-snug text-muted-foreground">
                  {t(isNativeApp() ? "map.notFoundIos" : local.problem === "denied" ? "location.deniedWeb" : "map.notFoundWeb")}
                </p>
                {isNativeApp() && !hasNativeLocation() && <p className="mt-1 text-caption leading-snug text-muted-foreground">{t("map.oldApp")}</p>}
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={local.retry} className="h-10 flex-1 rounded-full bg-primary text-caption font-semibold text-primary-foreground">
                    {t("map.retry")}
                  </button>
                  {isNativeApp() && (
                    <button type="button" onClick={openLocationSettings} className="h-10 flex-1 rounded-full bg-secondary text-caption font-semibold">
                      {t("location.openSettings")}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* nearby list */}
      <Drawer open={listOpen} onOpenChange={setListOpen}>
        <DrawerContent className="max-h-[80vh]">
          <DrawerTitle className="px-4 pt-2 text-body font-semibold">{t("map.nearby", { count: nearby.length })}</DrawerTitle>
          <DrawerDescription className="px-4 text-caption text-muted-foreground">{t("map.listHint", { radius: formatDistance(radius, i18n.language) })}</DrawerDescription>
          <ul className="overflow-y-auto px-4 pb-8 pt-2">
            {nearby.length === 0 && <li className="py-6 text-center text-caption text-muted-foreground">{t("map.nobody")}</li>}
            {nearby.map((p) => (
              <li key={p.user_id}>
                <button
                  type="button"
                  onClick={() => {
                    setListOpen(false);
                    select(p);
                  }}
                  className="flex w-full items-center gap-3 py-2.5 text-left"
                >
                  <span className={cn("rounded-full p-0.5 ring-2", p.is_friend ? "ring-success" : "ring-transparent")}>
                    <UserAvatar name={p.full_name || p.username} path={p.avatar_path} size={44} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{p.full_name || p.username}</span>
                    <span className="block truncate text-caption text-muted-foreground">
                      {[formatDistance(distOf(p), i18n.language), p.is_friend ? t("map.friend") : null].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </DrawerContent>
      </Drawer>

      {/* one person */}
      <Drawer open={!!current} onOpenChange={(o) => !o && select(null)}>
        <DrawerContent>
          {current && (
            <div className="px-5 pb-8 pt-3">
              <div className="flex items-center gap-4">
                <span className={cn("rounded-full p-1 ring-4", current.is_friend ? "ring-success" : "ring-border")}>
                  <UserAvatar name={current.full_name || current.username} path={current.avatar_path} size={64} />
                </span>
                <div className="min-w-0 flex-1">
                  <DrawerTitle className="truncate text-tagline font-semibold">{current.full_name || current.username}</DrawerTitle>
                  <DrawerDescription className="truncate text-caption text-muted-foreground">@{current.username}</DrawerDescription>
                  <p className="mt-0.5 text-caption font-semibold text-link">
                    {t("map.away", { distance: formatDistance(distOf(current), i18n.language) })} ·{" "}
                    {ageOf(current) ? t("map.lastSeen", { when: ageOf(current) }) : t("map.now")}
                  </p>
                  {current.accuracy_m != null && (
                    <p className="text-fine text-muted-foreground">{t("map.accuracy", { distance: formatDistance(current.accuracy_m, i18n.language) })}</p>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={t("friends.actions")}
                  onClick={() => {
                    setActionsFor(current);
                    select(null);
                  }}
                  className="grid h-11 w-11 shrink-0 place-items-center self-start rounded-full bg-secondary"
                >
                  <MoreHorizontal className="h-5 w-5" />
                </button>
              </div>
              {current.is_friend ? (
                <div className="mt-5 grid grid-cols-2 gap-2">
                  <Link
                    to="/talk/$userId"
                    params={{ userId: current.user_id }}
                    className="flex h-12 items-center justify-center gap-2 rounded-full bg-primary font-semibold text-primary-foreground"
                  >
                    <RadioTower className="h-5 w-5" /> {t("walkie.title")}
                  </Link>
                  <a
                    href={directionsUrl(current.lat, current.lng)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-12 items-center justify-center gap-2 rounded-full bg-secondary font-semibold"
                  >
                    <Navigation className="h-5 w-5" /> {t("map.directions")}
                  </a>
                </div>
              ) : (
                on && <NearbyTalk person={current} />
              )}
              <div className={cn("grid grid-cols-2 gap-2", current.is_friend ? "mt-2" : "mt-4")}>
                <FollowButton userId={current.user_id} />
                <Link
                  to="/u/$username"
                  params={{ username: current.username }}
                  className="flex h-12 items-center justify-center rounded-full bg-secondary font-semibold"
                >
                  {t("map.profile")}
                </Link>
              </div>
            </div>
          )}
        </DrawerContent>
      </Drawer>

      <PersonActionsSheet
        person={actionsFor && { id: actionsFor.user_id, username: actionsFor.username, full_name: actionsFor.full_name, avatar_path: actionsFor.avatar_path }}
        onOpenChange={(o) => !o && setActionsFor(null)}
        onBlocked={() => {
          if (actionsFor) forgetNearby(actionsFor.user_id);
          void qc.invalidateQueries({ queryKey: ["location"] });
        }}
      />
    </div>
  );
}
