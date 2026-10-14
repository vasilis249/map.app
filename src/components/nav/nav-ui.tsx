import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Loader2,
  Merge,
  Navigation,
  RotateCw,
  Ship,
  Undo2,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { formatDistance } from "@/lib/location/format";
import { arrivalTime, formatDuration } from "@/lib/nav/format";
import type { ManeuverKind, NavManeuver } from "@/lib/nav/route";
import { chooseRoute, setMuted, startNav, stopNav, type NavState, type NavTexts } from "@/lib/nav/session";
import { cn } from "@/lib/utils";

const ICONS: Record<ManeuverKind, LucideIcon> = {
  depart: Navigation,
  arrive: Flag,
  straight: ArrowUp,
  "slight-right": ArrowUpRight,
  right: CornerUpRight,
  "sharp-right": CornerUpRight,
  "slight-left": ArrowUpLeft,
  left: CornerUpLeft,
  "sharp-left": CornerUpLeft,
  uturn: Undo2,
  "ramp-right": ArrowUpRight,
  "ramp-left": ArrowUpLeft,
  merge: Merge,
  roundabout: RotateCw,
  ferry: Ship,
};

export function ManeuverIcon({ kind, className }: { kind: ManeuverKind; className?: string }) {
  const Icon = ICONS[kind] ?? ArrowUp;
  return <Icon className={className} aria-hidden />;
}

/** What the banner names: the street after the maneuver, else the provider's written instruction. */
const label = (m: NavManeuver) => m.street ?? m.instruction;

/**
 * Top of the screen while navigating: the next maneuver (arrow, distance, street) in big type, readable at a glance;
 * the one after it when it comes right after; "off route" / "new route…" while rerouting.
 */
export function NavBanner({ nav }: { nav: NavState }) {
  const { t, i18n } = useTranslation();
  const r = nav.route;
  const p = nav.progress;
  if (!r) return null;
  if (nav.phase === "arrived")
    return (
      <div role="status" className="flex w-full items-center gap-4 rounded-3xl bg-success p-4 text-white shadow-float">
        <Flag className="h-10 w-10 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-tagline font-bold">{t("nav.arrived")}</p>
          <p className="truncate text-callout opacity-90">{nav.dest?.name}</p>
        </div>
      </div>
    );
  const m = r.route.maneuvers;
  const next = m[p?.next ?? Math.min(1, m.length - 1)];
  const after = p && p.next + 1 < m.length ? m[p.next + 1] : null;
  const afterClose = after && p && r.at[p.next + 1] - r.at[p.next] < 200;
  const lost = p?.offRoute || nav.rerouting;
  return (
    <div className="w-full overflow-hidden rounded-3xl bg-[#1c1c1e]/90 text-white shadow-float backdrop-blur-xl backdrop-saturate-150" role="status" aria-live="polite" data-testid="nav-banner">
      <div className="flex items-center gap-4 p-4">
        {lost ? (
          <Loader2 className="h-12 w-12 shrink-0 animate-spin" aria-hidden />
        ) : (
          <ManeuverIcon kind={next.kind} className="h-12 w-12 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          {lost ? (
            <p className="text-tagline font-bold">{nav.rerouting ? t("nav.rerouting") : t("nav.offRoute")}</p>
          ) : (
            <>
              <p className="text-[2rem] font-bold leading-none tabular-nums" data-testid="nav-distance">
                {formatDistance(p ? p.toNext : r.at[1] ?? 0, i18n.language)}
              </p>
              <p className="mt-1 line-clamp-2 text-callout font-semibold leading-snug" data-testid="nav-instruction">
                {label(next)}
              </p>
            </>
          )}
        </div>
      </div>
      {!lost && afterClose && after && (
        <div className="flex items-center gap-2 border-t border-white/10 bg-white/5 px-4 py-2 text-caption font-semibold text-white/85">
          <span>{t("nav.then")}</span>
          <ManeuverIcon kind={after.kind} className="h-5 w-5" />
          <span className="truncate">{label(after)}</span>
        </div>
      )}
    </div>
  );
}

/** Bottom of the screen while navigating: arrival time, time and distance left, voice on/off, end. */
export function NavFooter({ nav }: { nav: NavState }) {
  const { t, i18n } = useTranslation();
  const r = nav.route;
  if (!r) return null;
  const eta = nav.progress?.eta_s ?? r.route.time_s;
  const left = nav.progress?.remaining ?? r.total;
  return (
    <div className="flex items-center gap-3 rounded-3xl glass border border-border/60 p-3 shadow-float">
      <div className="min-w-0 flex-1 pl-1">
        <p className="text-tagline font-bold tabular-nums" data-testid="nav-eta">
          {t("nav.arrival", { time: arrivalTime(eta, i18n.language) })}
        </p>
        <p className="text-caption text-muted-foreground tabular-nums">
          {formatDuration(eta, t)} · {formatDistance(left, i18n.language)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setMuted(!nav.muted)}
        aria-label={nav.muted ? t("nav.unmute") : t("nav.mute")}
        aria-pressed={nav.muted}
        className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-secondary"
      >
        {nav.muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
      </button>
      <button type="button" onClick={stopNav} className="h-12 shrink-0 rounded-full bg-destructive px-5 font-semibold text-white">
        {t("nav.end")}
      </button>
    </div>
  );
}

/** Route choices for a destination: time, distance, main road; the fastest first. Start / cancel. */
export function RoutePreview({ nav, texts }: { nav: NavState; texts: NavTexts }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="rounded-3xl glass border border-border/60 p-4 shadow-float" data-testid="route-preview">
      <p className="truncate text-callout font-semibold">{t("nav.routes", { place: nav.dest?.name ?? "" })}</p>
      {nav.phase === "loading" && (
        <p className="mt-3 flex items-center gap-2 text-caption text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("nav.loading")}
        </p>
      )}
      {nav.error && <p className="mt-3 text-caption font-semibold text-destructive">{t(`nav.errors.${nav.error}`)}</p>}
      {nav.routes.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2" aria-label={t("nav.routes", { place: nav.dest?.name ?? "" })}>
          {nav.routes.map((r, i) => {
            const fastest = nav.routes.every((o) => o.time_s >= r.time_s);
            const tags = [r.toll && t("nav.toll"), r.highway && t("nav.highway"), r.ferry && t("nav.ferry")].filter(Boolean);
            return (
              <li key={i}>
                <button
                  type="button"
                  aria-pressed={nav.chosen === i}
                  onClick={() => chooseRoute(i)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl border-2 px-3 py-2 text-left",
                    nav.chosen === i ? "border-primary bg-primary/10" : "border-transparent bg-secondary",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-bold tabular-nums">
                      {formatDuration(r.time_s, t)} <span className="font-normal text-muted-foreground">· {formatDistance(r.length_m, i18n.language)}</span>
                    </span>
                    <span className="block truncate text-caption text-muted-foreground">
                      {[r.via && t("nav.via", { road: r.via }), ...tags].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {fastest && nav.routes.length > 1 && <span className="shrink-0 text-fine font-semibold text-success">{t("nav.fastest")}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={stopNav} className="h-12 rounded-full bg-secondary font-semibold">
          {t("nav.cancel")}
        </button>
        <button
          type="button"
          disabled={!nav.routes.length}
          onClick={() => startNav(texts, i18n.language)}
          className="flex h-12 items-center justify-center gap-2 rounded-full bg-primary font-semibold text-primary-foreground disabled:opacity-50"
        >
          <Navigation className="h-5 w-5" /> {t("nav.start")}
        </button>
      </div>
    </div>
  );
}

/** Live speed, like Google Maps' bubble: big number, "km/h" under it; "–" until the phone knows. */
/**
 * Your speed (km/h bubble) and, where the map knows it, the speed limit beside it (a European round sign). Over the
 * limit the bubble turns red (Waze).
 */
export function SpeedBubble({ kmh, limit = null, over = false }: { kmh: number | null; limit?: number | null; over?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-none flex items-end gap-1.5">
      <div
        className={cn(
          "grid h-16 w-16 shrink-0 place-items-center rounded-full border shadow-float transition-colors",
          over ? "border-transparent bg-[#ff3b30] text-white" : "glass border-border/60",
        )}
        data-testid="nav-speed"
        data-over={over ? "1" : "0"}
        aria-label={kmh == null ? undefined : `${kmh} km/h`}
      >
        <div className="text-center leading-none">
          <span className="block text-[1.6rem] font-bold tabular-nums">{kmh == null ? "–" : kmh}</span>
          <span className={cn("block text-[10px] font-semibold uppercase tracking-wide", over ? "text-white/85" : "text-muted-foreground")}>km/h</span>
        </div>
      </div>
      {limit != null && (
        <div
          data-testid="nav-limit"
          aria-label={t("nav.limit", { limit })}
          className="grid h-12 w-12 place-items-center rounded-full border-[5px] border-[#e5252a] bg-white text-[1.1rem] font-bold tabular-nums text-black shadow-float"
        >
          {limit}
        </div>
      )}
    </div>
  );
}
