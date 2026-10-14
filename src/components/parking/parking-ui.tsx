import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Navigation } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { formatDistance } from "@/lib/location/format";
import type { ParkingSpot } from "@/lib/parking/parking";
import { timeAgoShort } from "@/lib/time-ago";

export const PARKING_GREEN = "#30d158";
export const PARKING_RED = "#ff3b30";

/** The "P" square used on the map, in tiles and cards. */
export function ParkingBadge({ state, size = 44 }: { state: "free" | "taken"; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-xl font-extrabold text-white"
      style={{ background: state === "free" ? PARKING_GREEN : PARKING_RED, width: size, height: size, fontSize: size * 0.48 }}
      aria-hidden
    >
      P
    </span>
  );
}

/** Two big answers: leaving my spot (green for others) / I parked here (red). */
export function ParkingSheet({
  open,
  onOpenChange,
  onLeave,
  onPark,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onLeave: () => void;
  onPark: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <div className="px-5 pb-8 pt-3">
          <DrawerTitle className="text-tagline font-semibold">{t("parking.title")}</DrawerTitle>
          <DrawerDescription className="text-caption text-muted-foreground">{t("parking.hint")}</DrawerDescription>
          <div className="mt-4 grid gap-3">
            <button type="button" onClick={onLeave} className="glass-tile flex h-20 items-center gap-4 rounded-3xl px-4 text-left active:scale-[0.98]">
              <ParkingBadge state="free" size={48} />
              <span>
                <span className="block text-body font-semibold">{t("parking.leave")}</span>
                <span className="block text-caption text-muted-foreground">{t("parking.leaveHint")}</span>
              </span>
            </button>
            <button type="button" onClick={onPark} className="glass-tile flex h-20 items-center gap-4 rounded-3xl px-4 text-left active:scale-[0.98]">
              <ParkingBadge state="taken" size={48} />
              <span>
                <span className="block text-body font-semibold">{t("parking.park")}</span>
                <span className="block text-caption text-muted-foreground">{t("parking.parkHint")}</span>
              </span>
            </button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** One spot from the map: free since … (directions, "taken"), or taken. */
export function ParkingDetailSheet({
  spot,
  onClose,
  onGo,
  onTaken,
}: {
  spot: ParkingSpot | null;
  onClose: () => void;
  onGo: (s: ParkingSpot) => void;
  onTaken: (s: ParkingSpot) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Drawer open={!!spot} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent>
        {spot && (
          <div className="px-5 pb-8 pt-3">
            <div className="flex items-center gap-4">
              <ParkingBadge state={spot.state} size={52} />
              <div className="min-w-0 flex-1">
                <DrawerTitle className="text-tagline font-semibold">{t(spot.state === "free" ? "parking.free" : "parking.taken")}</DrawerTitle>
                <DrawerDescription className="text-caption text-muted-foreground">
                  {[t("road.ago", { when: timeAgoShort(spot.updated_at, i18n.language) }), spot.mine ? t("parking.yours") : null].filter(Boolean).join(" · ")}
                </DrawerDescription>
              </div>
            </div>
            {spot.state === "free" && !spot.mine && (
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onGo(spot)}
                  className="flex h-14 items-center justify-center gap-2 rounded-full font-semibold text-white"
                  style={{ background: PARKING_GREEN }}
                >
                  <Navigation className="h-5 w-5" /> {t("parking.go")}
                </button>
                <button type="button" onClick={() => onTaken(spot)} className="glass-tile flex h-14 items-center justify-center rounded-full font-semibold">
                  {t("parking.gotTaken")}
                </button>
              </div>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

/** A yes / no question about parking ("Did you park?", "Did you free your spot?"); goes away by itself after 20 s. */
export function ParkingAskCard({
  state,
  question,
  yes,
  onYes,
  onNo,
  testId,
}: {
  state: "free" | "taken";
  question: string;
  yes: string;
  onYes: () => void;
  onNo: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const id = setTimeout(onNo, 20_000);
    return () => clearTimeout(id);
  }, [onNo]);
  return (
    <div data-testid={testId} className="rounded-3xl glass p-4">
      <div className="flex items-center gap-3">
        <ParkingBadge state={state} size={40} />
        <p className="text-body font-semibold">{question}</p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onYes}
          className="flex h-14 items-center justify-center rounded-2xl text-body font-semibold text-white"
          style={{ background: state === "free" ? PARKING_GREEN : PARKING_RED }}
        >
          {yes}
        </button>
        <button type="button" onClick={onNo} className="glass-tile flex h-14 items-center justify-center rounded-2xl text-body font-semibold">
          {t("parking.notNow")}
        </button>
      </div>
    </div>
  );
}

/** Close to your destination: "Free spot 120 m from your destination — Go". */
export function DestParkingChip({ distance, onGo }: { distance: number; onGo: () => void }) {
  const { t, i18n } = useTranslation();
  return (
    <button
      type="button"
      onClick={onGo}
      data-testid="dest-parking"
      className="flex items-center gap-3 rounded-full bg-[#1c1c1e]/90 py-2 pl-2 pr-5 text-left text-white shadow-float backdrop-blur-xl"
    >
      <ParkingBadge state="free" size={36} />
      <span className="text-callout font-semibold">{t("parking.nearDest", { distance: formatDistance(distance, i18n.language) })}</span>
    </button>
  );
}
