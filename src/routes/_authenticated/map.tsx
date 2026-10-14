import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LocateFixed, MapPin, MoreHorizontal, Navigation, RadioTower, Search, Users } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { GhostButton } from "@/components/location/ghost-button";
import { LiveMap, type MapFocus } from "@/components/map/live-map";
import { NearbyTalk } from "@/components/map/nearby-talk";
import { NavBanner, NavFooter, RoutePreview, SpeedBubble } from "@/components/nav/nav-ui";
import { NavSearch } from "@/components/nav/nav-search";
import { spokenDistance } from "@/lib/nav/format";
import { spokenMetres } from "@/lib/nav/guidance";
import { RoadAheadChip, RoadAskCard, RoadDetailSheet, roadLabel, RoadReportButton, RoadReportSheet } from "@/components/road/road-ui";
import { createRoadReport, RoadApiError, reportRoadAbuse, voteRoadReport, withdrawRoadReport } from "@/lib/reports/api";
import { closures, createReportAlerts, relevant, routeSlice, trafficAhead, type RoadKind, type RoadReport } from "@/lib/reports/road";
import { limitAt } from "@/lib/nav/route";
import { createSpeedWatch } from "@/lib/nav/speed-limit";
import { useRoadReports } from "@/lib/reports/use-road";
import { toast } from "sonner";
import type { Place } from "@/lib/nav/route";
import { announce, chooseRoute, planTo, rerouteNow, setAvoid, useNav, type NavTexts } from "@/lib/nav/session";
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
  // Navigation (P4): planning a trip (search → route choices) or following one.
  const nav = useNav();
  // While navigating, people around you refresh every 2 s (their 3D cars glide between updates), else every 5 s.
  const people = useQuery({
    queryKey: locationKeys.people(radius),
    queryFn: () => mapPeople(radius),
    enabled: on,
    refetchInterval: nav.phase === "navigating" ? 2_000 : 5_000,
  });
  const { u } = Route.useSearch();
  const navigate = useNavigate({ from: "/map" });
  const [listOpen, setListOpen] = useState(false);
  // Report / block someone from their card (App Store 1.2: every place you meet people has both).
  const [actionsFor, setActionsFor] = useState<MapPerson | null>(null);
  // A specific saved transmission to report (from the card's history), else the person.
  const [reportItem, setReportItem] = useState<string | null>(null);
  const qc = useQueryClient();
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const move = (target: MapFocus["target"]) => setFocus((f) => ({ key: (f?.key ?? 0) + 1, target }));
  const talking = useHubPeers()
    .filter((p) => p.kind === "nearby" && p.snap.peerTalking)
    .map((p) => p.peer);
  const local = useLocalFix();
  const compass = useCompass();
  const [searching, setSearching] = useState(false);
  const navActive = nav.phase === "navigating" || nav.phase === "arrived";
  const planning = nav.phase === "loading" || nav.phase === "preview";
  const plain = !navActive && !planning;
  const navTexts: NavTexts = {
    phrase: (m, instruction) => t("nav.say.inDistance", { distance: spokenDistance(m, t, i18n.language), instruction }),
    rerouted: t("nav.say.rerouted"),
    bgTitle: t("nav.bgTitle"),
    bgMessage: t("nav.bgMessage", { place: nav.dest?.name ?? "" }),
  };

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
  // While navigating: everyone within 200 m (friends included), so you can still talk to them.
  const shown = navActive ? list.filter((p) => p.distance_m <= NEAR_M) : view === "friends" ? friends : nearby;
  // While navigating, the line shows only the road still ahead (from where you are on it), like Apple Maps.
  const routePts = nav.route?.route.points ?? [];
  const aheadOfYou: [number, number][] = nav.progress
    ? [[nav.progress.snapped.lng, nav.progress.snapped.lat], ...routePts.slice(nav.progress.seg + 1)]
    : routePts;
  // Road reports (Waze-style): pins on the map; while navigating, a warning for those on the route ahead (chip +
  // voice) and "still there?" as you pass one.
  const roads = useRoadReports(me, navActive ? nav.route : null);
  const roadList = roads.data ?? [];
  const [reporting, setReporting] = useState(false);
  const [roadOpen, setRoadOpen] = useState<string | null>(null);
  const [roadAsk, setRoadAsk] = useState<RoadReport | null>(null);
  const [roadWarn, setRoadWarn] = useState<string | null>(null);
  const roadAlerts = useRef(createReportAlerts());
  const roadAhead = navActive && nav.route && nav.progress ? relevant(roadList, nav.fix, nav.route, nav.progress.along) : [];
  const warnNow = roadWarn ? roadAhead.find((a) => a.report.id === roadWarn && a.distance > 30) : undefined;
  useEffect(() => {
    if (navActive) roadAlerts.current = createReportAlerts();
    else {
      setRoadAsk(null);
      setRoadWarn(null);
    }
  }, [navActive]);
  const progressAlong = nav.progress?.along;
  useEffect(() => {
    if (!navActive || progressAlong == null) return;
    const e = roadAlerts.current.next(roadAhead, nav.fix?.speed, nav.fix);
    if (!e) return;
    if (e.type === "ask") return setRoadAsk(e.report);
    setRoadWarn(e.report.id);
    const kind = roadLabel(t, e.report.kind, e.report.sub);
    announce(`road:${e.report.id}`, t("road.sayAhead", { kind, distance: spokenDistance(spokenMetres(e.distance), t, i18n.language) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressAlong, navActive]);
  // Traffic reported on the route ahead: coloured on the line, its delay added to the arrival time (Waze).
  const traffic = navActive && nav.route && nav.progress ? trafficAhead(roadAhead, nav.progress.along) : { jams: [], delay_s: 0 };
  const jamsKey = traffic.jams.map((j) => `${j.level}:${Math.round(j.from / 20)}:${Math.round(j.to / 20)}`).join("|");
  const navRoute = nav.route;
  const jamLines = useMemo(
    () => (navRoute ? traffic.jams.map((j) => ({ level: j.level, coords: routeSlice(navRoute, j.from, j.to) })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jamsKey, navRoute],
  );
  // Closed roads: routes go around them; one reported on your route ahead while navigating → a new route at once.
  const closedKey = roadList.filter((r) => r.kind === "closed").map((r) => r.id).join();
  useEffect(() => {
    setAvoid(closures(roadList, me));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedKey]);
  const closedHandled = useRef(new Set<string>());
  useEffect(() => {
    if (!navActive) return void closedHandled.current.clear();
    const c = roadAhead.find((a) => a.onRoute && a.report.kind === "closed" && a.distance > 60 && !closedHandled.current.has(a.report.id));
    if (!c) return;
    closedHandled.current.add(c.report.id);
    announce(`closed:${c.report.id}`, t("nav.closedAhead"));
    rerouteNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressAlong, navActive, closedKey]);
  // Speed limit where the map knows it; over it: the speedometer turns red and the limit is said once.
  const limit = navActive && nav.route && nav.progress ? limitAt(nav.route.route, nav.progress.along) : null;
  const speedWatch = useRef(createSpeedWatch());
  const [speeding, setSpeeding] = useState(false);
  useEffect(() => {
    if (!navActive) {
      speedWatch.current = createSpeedWatch();
      return setSpeeding(false);
    }
    const st = speedWatch.current.update(nav.speedKmh, limit, Date.now());
    setSpeeding(st.over);
    if (st.say != null) announce(`limit:${st.say}`, t("nav.sayLimit", { limit: st.say }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navActive, nav.speedKmh, limit]);
  const roadError = (e: unknown) =>
    toast(t(e instanceof RoadApiError && e.code !== "generic" ? `road.errors.${e.code}` : "errors.generic"));
  const refreshRoads = () => void qc.invalidateQueries({ queryKey: ["road"] });
  const reportRoad = (kind: RoadKind, sub: string | null) => {
    setReporting(false);
    if (!me) return void toast(t("road.errors.no_position"));
    createRoadReport(kind, sub, me, nav.fix?.course ?? local.fix?.course ?? null)
      .then(() => {
        toast(t("road.thanks"));
        refreshRoads();
      })
      .catch(roadError);
  };
  const voteRoad = (r: RoadReport, v: 1 | -1) => {
    setRoadOpen(null);
    setRoadAsk(null);
    voteRoadReport(r.id, v)
      .then(() => {
        toast(t("road.votedThanks"));
        refreshRoads();
      })
      .catch(roadError);
  };
  const planFrom = (dest: Place) => {
    if (me) void planTo(dest, me, i18n.language);
  };

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
  useEffect(() => {
    if (navActive) setRadius(NEAR_M);
  }, [navActive]);

  return (
    <div className="fixed inset-0 z-0 bg-background">
      <LiveMap
        me={me}
        meFace={{ name: profile.data?.full_name || profile.data?.username || "", path: profile.data?.avatar_path ?? null }}
        radius={view === "nearby" && plain ? radius : null}
        people={shown}
        onSelect={select}
        focus={focus}
        talking={talking}
        heading={navActive ? (nav.fix?.course ?? nav.progress?.routeBearing ?? heading) : heading}
        ageOf={ageOf}
        lang={i18n.language}
        roads={roadList}
        roadLabel={(k) => t(`road.kinds.${k}`)}
        onSelectRoad={setRoadOpen}
        nav={
          navActive && nav.route && nav.dest
            ? { lines: [aheadOfYou], chosen: 0, dest: nav.dest, mode: "follow", bearing: nav.fix?.course ?? nav.progress?.routeBearing ?? null, motion: nav.motion, traffic: jamLines }
            : planning && nav.dest
              ? { lines: nav.routes.map((r) => r.points), chosen: nav.chosen, dest: nav.dest, mode: "preview", bearing: null, onChoose: chooseRoute }
              : null
        }
      />

      {searching && (
        <NavSearch
          near={me}
          onClose={() => setSearching(false)}
          onPick={(p) => {
            setSearching(false);
            planFrom(p);
          }}
        />
      )}

      {/* top: the next maneuver while navigating; else "where to?" and friends | nearby (+ radius) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        {navActive && (
          <div className="pointer-events-auto w-full max-w-md">
            <NavBanner nav={nav} />
          </div>
        )}
        {navActive && warnNow && <RoadAheadChip report={warnNow.report} distance={warnNow.distance} />}
        {plain && (
          <button
            type="button"
            onClick={() => setSearching(true)}
            disabled={!me}
            className="pointer-events-auto flex h-12 w-full max-w-md items-center gap-3 rounded-full glass border border-border/60 px-5 text-left text-callout font-semibold text-muted-foreground shadow-float disabled:opacity-60"
          >
            <Search className="h-5 w-5 text-link" /> {t("nav.whereTo")}
          </button>
        )}
        <div className={cn("pointer-events-auto flex items-center gap-1 rounded-full glass border border-border/60 shadow-float p-1", !plain && "hidden")} role="tablist">
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
        {view === "nearby" && plain && (
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
      {/* Only the controls themselves take taps: the empty space around them lets taps reach the map's markers. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+6.5rem)] z-10 flex flex-col gap-3 px-4 [&>*:not(.pass-through)]:pointer-events-auto">
        {/* ghost mode (one tap) · back to me */}
        <div className="pass-through flex items-end justify-between gap-3">
          <div className="flex items-end gap-2">
            {navActive && <SpeedBubble kmh={nav.speedKmh} limit={limit} over={speeding} />}
            {s ? <GhostButton sharing={s} /> : <span />}
          </div>
          <div className="flex items-end gap-2">
          {me && !planning && <RoadReportButton onClick={() => setReporting(true)} />}
          {me && (
            <button
              type="button"
              onClick={() => {
                move(view === "nearby" ? "radius" : "me");
                void enableCompass(); // inside the tap: iOS asks for motion access once
              }}
              aria-label={t("map.recenter")}
              className="pointer-events-auto grid h-12 w-12 place-items-center rounded-full glass border border-border/60 shadow-float"
            >
              <LocateFixed className="h-5 w-5 text-link" />
            </button>
          )}
          </div>
        </div>

        {navActive && roadAsk && <RoadAskCard report={roadAsk} onVote={(v) => voteRoad(roadAsk, v)} onDismiss={() => setRoadAsk(null)} />}

        {navActive && <NavFooter nav={nav} delay_s={traffic.delay_s} />}
        {planning && <RoutePreview nav={nav} texts={navTexts} onReplan={() => nav.dest && planFrom(nav.dest)} />}

        {on && view === "friends" && plain && (
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

        {on && view === "nearby" && plain && (
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
        {s && !on && plain && (
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
        {/* Never taller than the screen: the big talk button + history scroll inside on small phones. */}
        <DrawerContent className="max-h-[92dvh]">
          {current && (
            <div className="min-h-0 overflow-y-auto px-5 pb-8 pt-3">
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
                  {me ? (
                    // In-app navigation to where your friend is now.
                    <button
                      type="button"
                      onClick={() => {
                        const to = { id: `user:${current.user_id}`, name: current.full_name || current.username, detail: "", lat: current.lat, lng: current.lng };
                        select(null);
                        planFrom(to);
                      }}
                      className="flex h-12 items-center justify-center gap-2 rounded-full bg-secondary font-semibold"
                    >
                      <Navigation className="h-5 w-5" /> {t("map.directions")}
                    </button>
                  ) : (
                    <a
                      href={directionsUrl(current.lat, current.lng)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex h-12 items-center justify-center gap-2 rounded-full bg-secondary font-semibold"
                    >
                      <Navigation className="h-5 w-5" /> {t("map.directions")}
                    </a>
                  )}
                </div>
              ) : (
                on && (
                  <NearbyTalk
                    person={current}
                    onReport={(item) => {
                      setReportItem(item.id);
                      setActionsFor(current);
                      select(null);
                    }}
                  />
                )
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

      <RoadReportSheet open={reporting} onOpenChange={setReporting} onPick={reportRoad} />
      <RoadDetailSheet
        report={roadList.find((r) => r.id === roadOpen) ?? null}
        onClose={() => setRoadOpen(null)}
        onVote={voteRoad}
        onWithdraw={(r) => {
          setRoadOpen(null);
          withdrawRoadReport(r.id)
            .then(() => {
              toast(t("road.withdrawn"));
              refreshRoads();
            })
            .catch(roadError);
        }}
        onAbuse={(r) => {
          setRoadOpen(null);
          reportRoadAbuse(r.id)
            .then(() => toast(t("road.abuseDone")))
            .catch(roadError);
        }}
      />

      <PersonActionsSheet
        person={actionsFor && { id: actionsFor.user_id, username: actionsFor.username, full_name: actionsFor.full_name, avatar_path: actionsFor.avatar_path }}
        report={reportItem ? { kind: "nearby", id: reportItem, label: t("talk.reportThis") } : undefined}
        onOpenChange={(o) => {
          if (o) return;
          setActionsFor(null);
          setReportItem(null);
        }}
        onBlocked={() => {
          if (actionsFor) forgetNearby(actionsFor.user_id);
          void qc.invalidateQueries({ queryKey: ["location"] });
        }}
      />
    </div>
  );
}
