import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Camera, CarFront, ChevronLeft, Construction, Flag, Gauge, LifeBuoy, Siren, ThumbsDown, ThumbsUp, Trash2, TriangleAlert, type LucideIcon } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { formatDistance } from "@/lib/location/format";
import { ROAD_KINDS, ROAD_SUBS, type RoadKind, type RoadReport } from "@/lib/reports/road";
import { timeAgoShort } from "@/lib/time-ago";
import { ParkingBadge } from "@/components/parking/parking-ui";

export const ROAD_ICON: Record<RoadKind, LucideIcon> = {
  accident: CarFront,
  police: Siren,
  hazard: TriangleAlert,
  traffic: Gauge,
  closed: Construction,
  camera: Camera,
  help: LifeBuoy,
};
export const ROAD_COLOR: Record<RoadKind, string> = {
  accident: "#ff3b30",
  police: "#0a84ff",
  hazard: "#ff9f0a",
  traffic: "#ff6a00",
  closed: "#c4001a",
  camera: "#5e5ce6",
  help: "#30b0c7",
};

/** What to call a report: its detail's full name ("Κρυμμένη αστυνομία"), else its kind ("Αστυνομία"). */
export function roadLabel(t: TFunction, kind: RoadKind, sub: string | null | undefined) {
  return sub ? t(`road.subs.${kind}.${sub}`) : t(`road.kinds.${kind}`);
}

function KindBadge({ kind, size = 44 }: { kind: RoadKind; size?: number }) {
  const Icon = ROAD_ICON[kind];
  return (
    <span className="grid shrink-0 place-items-center rounded-full text-white" style={{ background: ROAD_COLOR[kind], width: size, height: size }}>
      <Icon className="h-1/2 w-1/2" aria-hidden />
    </span>
  );
}

/** The big report button on the map (Waze's orange one): usable without looking for it. */
export function RoadReportButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("road.report")}
      className="pointer-events-auto grid h-14 w-14 place-items-center rounded-full border-2 border-white text-white shadow-float"
      style={{ background: "#ff9f0a" }}
    >
      <TriangleAlert className="h-7 w-7" />
    </button>
  );
}

/**
 * Waze's report sheet: big kind tiles, then (one more tap) the detail — or "Report: Police" without one. "Closed road"
 * has no details: one tap. No typing anywhere: safe enough at a red light.
 */
export function RoadReportSheet({
  open,
  onOpenChange,
  onPick,
  onParking,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (k: RoadKind, sub: string | null) => void;
  /** The eighth tile: parking (free / taken spots). */
  onParking: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<RoadKind | null>(null);
  useEffect(() => {
    if (!open) setKind(null);
  }, [open]);
  const choose = (k: RoadKind) => (ROAD_SUBS[k].length ? setKind(k) : onPick(k, null));
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[92dvh]">
        <div className="overflow-y-auto px-5 pb-8 pt-3">
          {!kind ? (
            <>
              <DrawerTitle className="text-tagline font-semibold">{t("road.title")}</DrawerTitle>
              <DrawerDescription className="text-caption text-muted-foreground">{t("road.hint")}</DrawerDescription>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {ROAD_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => choose(k)}
                    className="glass-tile flex h-28 flex-col items-center justify-center gap-2 rounded-3xl text-body font-semibold active:scale-[0.98]"
                  >
                    <KindBadge kind={k} size={52} />
                    {t(`road.kinds.${k}`)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={onParking}
                  className="glass-tile flex h-28 flex-col items-center justify-center gap-2 rounded-3xl text-body font-semibold active:scale-[0.98]"
                >
                  <ParkingBadge state="free" size={52} />
                  {t("parking.tile")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setKind(null)}
                  aria-label={t("road.back")}
                  className="glass-tile grid h-11 w-11 shrink-0 place-items-center rounded-full"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>
                <KindBadge kind={kind} size={44} />
                <DrawerTitle className="text-tagline font-semibold">{t(`road.kinds.${kind}`)}</DrawerTitle>
              </div>
              <DrawerDescription className="sr-only">{t("road.hint")}</DrawerDescription>
              {ROAD_SUBS[kind].map((group, gi) => (
                <div key={gi} className="mt-4">
                  {ROAD_SUBS[kind].length > 1 && (
                    <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                      {t(`road.groups.${gi === 0 ? "road" : "weather"}`)}
                    </p>
                  )}
                  <div className="grid grid-cols-3 gap-2.5">
                    {group.map((sub) => (
                      <button
                        key={sub}
                        type="button"
                        onClick={() => onPick(kind, sub)}
                        aria-label={t(`road.subs.${kind}.${sub}`)}
                        className="glass-tile flex h-24 flex-col items-center justify-center gap-1.5 rounded-3xl px-1 text-center text-footnote font-semibold leading-tight active:scale-[0.98]"
                      >
                        <KindBadge kind={kind} size={36} />
                        {t(`road.tiles.${kind}.${sub}`)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => onPick(kind, null)}
                className="mt-4 flex h-14 w-full items-center justify-center rounded-full text-body font-semibold text-white"
                style={{ background: ROAD_COLOR[kind] }}
              >
                {t("road.general", { kind: t(`road.kinds.${kind}`) })}
              </button>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** One report: what, how long ago, how many confirmed; still there / not there; report abuse. */
export function RoadDetailSheet({
  report,
  onClose,
  onVote,
  onAbuse,
  onWithdraw,
}: {
  report: RoadReport | null;
  onClose: () => void;
  onVote: (r: RoadReport, v: 1 | -1) => void;
  onAbuse: (r: RoadReport) => void;
  onWithdraw: (r: RoadReport) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Drawer open={!!report} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent>
        {report && (
          <div className="px-5 pb-8 pt-3">
            <div className="flex items-center gap-4">
              <KindBadge kind={report.kind} size={56} />
              <div className="min-w-0 flex-1">
                <DrawerTitle className="text-tagline font-semibold">{roadLabel(t, report.kind, report.sub)}</DrawerTitle>
                <DrawerDescription className="text-caption text-muted-foreground">
                  {[t("road.ago", { when: timeAgoShort(report.created_at, i18n.language) }), report.up ? t("road.confirmations", { count: report.up }) : null, report.mine ? t("road.yours") : null]
                    .filter(Boolean)
                    .join(" · ")}
                </DrawerDescription>
              </div>
            </div>
            {report.mine && (
              <button
                type="button"
                onClick={() => onWithdraw(report)}
                className="glass-tile mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-full font-semibold"
              >
                <Trash2 className="h-5 w-5" /> {t("road.withdraw")}
              </button>
            )}
            {!report.mine && (
              <>
                <p className="mt-5 text-callout font-semibold">{t("road.stillThere")}</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    aria-pressed={report.voted === 1}
                    onClick={() => onVote(report, 1)}
                    className="flex h-14 items-center justify-center gap-2 rounded-full bg-success font-semibold text-white"
                  >
                    <ThumbsUp className="h-5 w-5" /> {t("road.yes")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={report.voted === -1}
                    onClick={() => onVote(report, -1)}
                    className="flex h-14 items-center justify-center gap-2 rounded-full bg-secondary font-semibold"
                  >
                    <ThumbsDown className="h-5 w-5" /> {t("road.no")}
                  </button>
                </div>
                <button type="button" onClick={() => onAbuse(report)} className="mt-4 flex items-center gap-2 text-caption font-semibold text-muted-foreground">
                  <Flag className="h-4 w-4" /> {t("road.abuse")}
                </button>
              </>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

/** While navigating: the warning chip under the guidance banner ("Αστυνομία σε 400 μ"). */
export function RoadAheadChip({ report, distance }: { report: RoadReport; distance: number }) {
  const { t, i18n } = useTranslation();
  return (
    <div role="status" data-testid="road-ahead" className="flex items-center gap-3 rounded-full bg-[#1c1c1e]/90 py-2 pl-2 pr-5 text-white shadow-float backdrop-blur-xl">
      <KindBadge kind={report.kind} size={36} />
      <span className="text-callout font-semibold">{t("road.ahead", { kind: roadLabel(t, report.kind, report.sub), distance: formatDistance(distance, i18n.language) })}</span>
    </div>
  );
}

/** Passing a report: "Still there?" with two big answers; goes away by itself after 10 s. */
export function RoadAskCard({ report, onVote, onDismiss }: { report: RoadReport; onVote: (v: 1 | -1) => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const id = setTimeout(onDismiss, 10_000);
    return () => clearTimeout(id);
  }, [report.id, onDismiss]);
  return (
    <div data-testid="road-ask" className="rounded-3xl glass border border-border/60 p-4 shadow-float">
      <div className="flex items-center gap-3">
        <KindBadge kind={report.kind} size={40} />
        <p className="text-body font-semibold">
          {roadLabel(t, report.kind, report.sub)} — {t("road.stillThere")}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onVote(1)} className="flex h-16 items-center justify-center gap-2 rounded-2xl bg-success text-body font-semibold text-white">
          <ThumbsUp className="h-6 w-6" /> {t("road.yes")}
        </button>
        <button type="button" onClick={() => onVote(-1)} className="flex h-16 items-center justify-center gap-2 rounded-2xl bg-secondary text-body font-semibold">
          <ThumbsDown className="h-6 w-6" /> {t("road.no")}
        </button>
      </div>
    </div>
  );
}
