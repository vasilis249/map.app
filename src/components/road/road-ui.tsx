import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CarFront, Construction, Flag, Gauge, Siren, ThumbsDown, ThumbsUp, TriangleAlert, type LucideIcon } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { formatDistance } from "@/lib/location/format";
import { ROAD_KINDS, type RoadKind, type RoadReport } from "@/lib/reports/road";
import { timeAgoShort } from "@/lib/time-ago";

export const ROAD_ICON: Record<RoadKind, LucideIcon> = {
  accident: CarFront,
  police: Siren,
  hazard: TriangleAlert,
  traffic: Gauge,
  closed: Construction,
};
export const ROAD_COLOR: Record<RoadKind, string> = {
  accident: "#ff3b30",
  police: "#0a84ff",
  hazard: "#ff9f0a",
  traffic: "#ff6a00",
  closed: "#c4001a",
};

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

/** Five big tiles: one tap reports it where you are (no typing — safe enough to do at a red light). */
export function RoadReportSheet({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (k: RoadKind) => void }) {
  const { t } = useTranslation();
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[92dvh]">
        <div className="overflow-y-auto px-5 pb-8 pt-3">
          <DrawerTitle className="text-tagline font-semibold">{t("road.title")}</DrawerTitle>
          <DrawerDescription className="text-caption text-muted-foreground">{t("road.hint")}</DrawerDescription>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {ROAD_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => onPick(k)}
                className="flex h-28 flex-col items-center justify-center gap-2 rounded-3xl bg-secondary text-body font-semibold active:scale-[0.98]"
              >
                <KindBadge kind={k} size={52} />
                {t(`road.kinds.${k}`)}
              </button>
            ))}
          </div>
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
}: {
  report: RoadReport | null;
  onClose: () => void;
  onVote: (r: RoadReport, v: 1 | -1) => void;
  onAbuse: (r: RoadReport) => void;
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
                <DrawerTitle className="text-tagline font-semibold">{t(`road.kinds.${report.kind}`)}</DrawerTitle>
                <DrawerDescription className="text-caption text-muted-foreground">
                  {[t("road.ago", { when: timeAgoShort(report.created_at, i18n.language) }), report.up ? t("road.confirmations", { count: report.up }) : null, report.mine ? t("road.yours") : null]
                    .filter(Boolean)
                    .join(" · ")}
                </DrawerDescription>
              </div>
            </div>
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
      <span className="text-callout font-semibold">{t("road.ahead", { kind: t(`road.kinds.${report.kind}`), distance: formatDistance(distance, i18n.language) })}</span>
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
          {t(`road.kinds.${report.kind}`)} — {t("road.stillThere")}
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
