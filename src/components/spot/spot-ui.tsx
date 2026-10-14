import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Car, Mic, Navigation, X } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { NearbyTalk } from "@/components/map/nearby-talk";
import { ParkingBadge, PARKING_GREEN } from "@/components/parking/parking-ui";
import { UserAvatar } from "@/components/user-avatar";
import { haversine, type LatLng } from "@/lib/nav/geo";
import { formatDistance } from "@/lib/location/format";
import { GIVER_MSGS, TAKER_MSGS, type SpotMsg, type SpotOffer, type SpotState, type Vehicle } from "@/lib/spot/api";
import { COLOUR_HEX, COLOURS, formatPlate, plateOk, type Colour } from "@/lib/spot/plate";
import { cn } from "@/lib/utils";

/** A plate as on the car: white, black letters, the EU blue strip with GR. */
export function PlateBadge({ plate, large = false }: { plate: string; large?: boolean }) {
  return (
    <span
      data-testid="plate"
      className={cn(
        "inline-flex items-stretch overflow-hidden rounded-md border-2 border-black/80 bg-white font-bold tracking-wider text-black",
        large ? "h-9 text-lg" : "h-7 text-sm",
      )}
    >
      <span className="flex w-4 flex-col items-center justify-end bg-[#003399] pb-0.5 text-[7px] font-bold leading-none text-white">GR</span>
      <span className="flex items-center px-2 tabular-nums">{formatPlate(plate)}</span>
    </span>
  );
}

export function ColourDot({ colour, size = 14 }: { colour: Colour; size?: number }) {
  const v = COLOUR_HEX[colour];
  return <span aria-hidden className="inline-block shrink-0 rounded-full border border-black/20" style={{ width: size, height: size, background: v }} />;
}

/** "Λευκό Toyota Yaris · [ΙΚΑ-1234]" */
export function CarLine({ v }: { v: { plate: string | null; make: string | null; colour: Colour | null } }) {
  const { t } = useTranslation();
  if (!v.plate) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {v.colour && <ColourDot colour={v.colour} />}
      <span className="text-callout font-semibold">{[v.colour && t(`spot.colours.${v.colour}`), v.make].filter(Boolean).join(" ")}</span>
      <PlateBadge plate={v.plate} />
    </div>
  );
}

/** Your vehicle: plate (required for exchanges), make (optional), colour; a declaration you drive it lawfully. */
export function VehicleForm({ value, onSave, onRemove, busy }: { value: Vehicle | null; onSave: (v: { plate: string; make: string; colour: Colour }) => void; onRemove: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const [plate, setPlate] = useState(value ? formatPlate(value.plate) : "");
  const [make, setMake] = useState(value?.make ?? "");
  const [colour, setColour] = useState<Colour | null>(value?.colour ?? null);
  const [declared, setDeclared] = useState(!!value);
  useEffect(() => {
    if (!value) return;
    setPlate(formatPlate(value.plate));
    setMake(value.make ?? "");
    setColour(value.colour);
    setDeclared(true);
  }, [value]);
  const ok = plateOk(plate) && !!colour && declared && make.length <= 40;
  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-caption font-semibold text-muted-foreground">{t("spot.plate")}</span>
        <input
          value={plate}
          onChange={(e) => setPlate(e.target.value.toUpperCase().slice(0, 12))}
          placeholder={t("spot.platePh")}
          autoCapitalize="characters"
          autoComplete="off"
          className="mt-1 h-12 w-full rounded-2xl bg-secondary px-4 text-lg font-bold tracking-wider outline-none"
        />
      </label>
      <label className="block">
        <span className="text-caption font-semibold text-muted-foreground">{t("spot.make")}</span>
        <input
          value={make}
          onChange={(e) => setMake(e.target.value.slice(0, 40))}
          placeholder={t("spot.makePh")}
          className="mt-1 h-12 w-full rounded-2xl bg-secondary px-4 outline-none"
        />
      </label>
      <div>
        <span className="text-caption font-semibold text-muted-foreground">{t("spot.colour")}</span>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={t("spot.colour")}>
          {COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={colour === c}
              onClick={() => setColour(c)}
              className={cn("flex h-9 items-center gap-1.5 rounded-full px-3 text-caption font-semibold", colour === c ? "bg-link text-white" : "glass-tile")}
            >
              <ColourDot colour={c} size={12} /> {t(`spot.colours.${c}`)}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-start gap-3 text-caption">
        <input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} className="mt-0.5 h-5 w-5" />
        <span>
          {t("spot.declare")} <span className="text-muted-foreground">{t("spot.plateOnly")}</span>
        </span>
      </label>
      <button
        type="button"
        disabled={!ok || busy}
        onClick={() => colour && onSave({ plate, make, colour })}
        className="h-12 w-full rounded-full bg-primary font-semibold text-primary-foreground disabled:opacity-40"
      >
        {t("spot.save")}
      </button>
      {value && (
        <button type="button" onClick={onRemove} className="h-10 w-full text-caption font-semibold text-destructive">
          {t("spot.removeVehicle")}
        </button>
      )}
    </div>
  );
}

/** In the parking sheet: "Δίνω τη θέση μου" — leaving now / in 2 / 5 / 10 minutes. */
export function GiveSpot({ onGive, hasVehicle, onAddVehicle }: { onGive: (inMin: 0 | 2 | 5 | 10) => void; hasVehicle: boolean; onAddVehicle: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-3xl p-4 text-white" style={{ background: PARKING_GREEN }} data-testid="give-spot">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-white/25 text-xl font-extrabold">P</span>
        <div>
          <p className="text-body font-bold">{t("spot.give")}</p>
          <p className="text-caption text-white/90">{t("spot.giveHint")}</p>
        </div>
      </div>
      {hasVehicle ? (
        <div className="mt-3 grid grid-cols-4 gap-2">
          {([0, 2, 5, 10] as const).map((m) => (
            <button key={m} type="button" onClick={() => onGive(m)} className="h-12 rounded-2xl bg-white text-callout font-bold text-[#0b7a2f] active:scale-[0.97]">
              {t(`spot.in_${m}`)}
            </button>
          ))}
        </div>
      ) : (
        <button type="button" onClick={onAddVehicle} className="mt-3 h-12 w-full rounded-2xl bg-white text-callout font-bold text-[#0b7a2f]">
          <Car className="mr-2 inline h-5 w-5" />
          {t("spot.addVehicle")}
        </button>
      )}
    </div>
  );
}

const minutesTo = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));

/** An offered spot from the map: when it's freed, how far; "Τη θέλω · 1 credit". */
export function OfferSheet({
  offer,
  me,
  credits,
  hasVehicle,
  onClose,
  onClaim,
  onAddVehicle,
}: {
  offer: SpotOffer | null;
  me: LatLng | null;
  credits: number;
  hasVehicle: boolean;
  onClose: () => void;
  onClaim: (o: SpotOffer) => void;
  onAddVehicle: () => void;
}) {
  const { t, i18n } = useTranslation();
  const min = offer ? minutesTo(offer.leave_at) : 0;
  return (
    <Drawer open={!!offer} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent>
        {offer && (
          <div className="px-5 pb-8 pt-3" data-testid="offer-sheet">
            <div className="flex items-center gap-4">
              <ParkingBadge state="free" size={52} />
              <div className="min-w-0 flex-1">
                <DrawerTitle className="text-tagline font-semibold">{t("spot.offerTitle")}</DrawerTitle>
                <DrawerDescription className="text-caption text-muted-foreground">
                  {[min ? t("spot.leavesIn", { min }) : t("spot.leavesNow"), me ? t("spot.away", { distance: formatDistance(haversine(me, offer), i18n.language) }) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </DrawerDescription>
              </div>
            </div>
            {!hasVehicle ? (
              <>
                <p className="mt-4 text-caption text-muted-foreground">{t("spot.needVehicle")}</p>
                <button type="button" onClick={onAddVehicle} className="mt-3 h-14 w-full rounded-full bg-primary font-semibold text-primary-foreground">
                  {t("spot.addVehicle")}
                </button>
              </>
            ) : credits < 1 ? (
              <p className="mt-4 rounded-2xl glass-tile p-3 text-callout font-semibold">{t("spot.noCredits")}</p>
            ) : (
              <button
                type="button"
                onClick={() => onClaim(offer)}
                className="mt-5 flex h-14 w-full items-center justify-center rounded-full text-body font-bold text-white"
                style={{ background: PARKING_GREEN }}
              >
                {t("spot.claim")}
              </button>
            )}
            <p className="mt-3 text-center text-caption text-muted-foreground">{t("spot.credits", { count: credits })}</p>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

/** My open offer, waiting for someone to claim it. */
export function OfferWaiting({ leaveAt, onCancel }: { leaveAt: string; onCancel: () => void }) {
  const { t } = useTranslation();
  const min = minutesTo(leaveAt);
  return (
    <div className="flex items-center gap-3 rounded-3xl glass p-3" data-testid="offer-waiting">
      <ParkingBadge state="free" size={40} />
      <div className="min-w-0 flex-1">
        <p className="text-callout font-semibold">{t("spot.offered")}</p>
        <p className="text-caption text-muted-foreground">
          {t("spot.waitingTaker")} · {min ? t("spot.leavesIn", { min }) : t("spot.leavesNow")}
        </p>
      </div>
      <button type="button" onClick={onCancel} aria-label={t("spot.cancelOffer")} className="glass-tile grid h-11 w-11 shrink-0 place-items-center rounded-full">
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

/**
 * The exchange in progress, for both sides: the mate (photo, name, car + plate), how far / ETA / arrived, their last
 * quick message, one-tap messages, push-to-talk, and the actions (navigate · parked · cancel · didn't come).
 */
export function MatchPanel({
  state,
  me,
  onMsg,
  onNavigate,
  onDone,
  onCancel,
  onNoShow,
}: {
  state: SpotState;
  me: LatLng | null;
  onMsg: (m: SpotMsg) => void;
  onNavigate: () => void;
  onDone: () => void;
  onCancel: () => void;
  onNoShow: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [talking, setTalking] = useState(false);
  const m = state.match!;
  const name = m.mate.full_name || m.mate.username;
  const first = name.split(" ")[0];
  const giver = m.role === "giver";
  const spot = state.offer ?? null;
  const dist = m.mate_pos && (giver ? spot : me) ? haversine(m.mate_pos, giver ? spot! : me!) : null;
  const sinceMin = (Date.now() - new Date(m.created_at).getTime()) / 60_000;
  // "Didn't come": the giver after 10 minutes without an arrival; "Wasn't there": the taker once arrived.
  const canNoShow = giver ? !m.arrived_at && sinceMin >= 10 : !!m.arrived_at;
  const msgs = giver ? GIVER_MSGS : TAKER_MSGS;
  const status = giver
    ? m.arrived_at
      ? t("spot.arrived")
      : [t("spot.mateComing", { name: first }), m.eta_s != null ? t("spot.eta", { min: Math.max(1, Math.round(m.eta_s / 60)) }) : null, dist != null ? formatDistance(dist, i18n.language) : null]
          .filter(Boolean)
          .join(" · ")
    : m.arrived_at
      ? t("spot.youArrived")
      : [t("spot.mateWaiting", { name: first }), spot ? (minutesTo(spot.leave_at) ? t("spot.leavesIn", { min: minutesTo(spot.leave_at) }) : t("spot.leavesNow")) : null]
          .filter(Boolean)
          .join(" · ");
  const person = {
    user_id: m.mate.user_id,
    username: m.mate.username,
    full_name: m.mate.full_name,
    avatar_path: m.mate.avatar_path,
    lat: m.mate_pos?.lat ?? 0,
    lng: m.mate_pos?.lng ?? 0,
    accuracy_m: null,
    heading: null,
    updated_at: m.mate_pos?.at ?? new Date().toISOString(),
    distance_m: Math.round(dist ?? 0),
    is_friend: false,
    // spot mates may talk at any distance while the exchange runs (server: may_send_nearby)
    can_talk: true,
  };
  return (
    <div className="max-h-[60dvh] overflow-y-auto rounded-3xl glass p-4" data-testid="match-panel" data-vaul-no-drag>
      <div className="flex items-center gap-3">
        <UserAvatar name={name} path={m.mate.avatar_path} size={44} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-bold">{name}</p>
          <p className={cn("text-caption", m.arrived_at ? "font-semibold text-success" : "text-muted-foreground")} data-testid="match-status">
            {status}
          </p>
        </div>
      </div>
      <div className="mt-2">
        <CarLine v={m.mate} />
      </div>
      {m.mate_msg && (
        <p className="mt-2 rounded-2xl glass-tile px-3 py-1.5 text-callout font-semibold" data-testid="mate-msg">
          {t("spot.says", { name: first, msg: t(`spot.msgs.${m.mate_msg}`) })}
        </p>
      )}
      {/* one row of quick messages, scrolled sideways */}
      <div className="no-scrollbar -mx-1 mt-3 flex gap-2 overflow-x-auto px-1">
        {msgs.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => onMsg(x)}
            aria-pressed={m.my_msg === x}
            className={cn("h-10 shrink-0 rounded-full px-4 text-caption font-semibold", m.my_msg === x ? "bg-link text-white" : "glass-tile")}
          >
            {t(`spot.msgs.${x}`)}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setTalking(true)} className="flex h-12 items-center justify-center gap-2 rounded-full bg-live font-semibold text-white">
          <Mic className="h-5 w-5" /> {t("spot.talk")}
        </button>
        {giver ? (
          <button type="button" onClick={onCancel} className="glass-tile h-12 rounded-full font-semibold">
            {t("spot.cancel")}
          </button>
        ) : (
          <button type="button" onClick={onNavigate} className="flex h-12 items-center justify-center gap-2 rounded-full bg-link font-semibold text-white">
            <Navigation className="h-5 w-5" /> {t("spot.navigate")}
          </button>
        )}
      </div>
      {!giver && (
        <button
          type="button"
          onClick={onDone}
          className="mt-2 h-12 w-full rounded-full text-body font-bold text-white"
          style={{ background: PARKING_GREEN }}
        >
          {t("spot.parked")}
        </button>
      )}
      <div className="mt-2 flex justify-center gap-6">
        {!giver && (
          <button type="button" onClick={onCancel} className="h-9 text-caption font-semibold text-muted-foreground">
            {t("spot.cancel")}
          </button>
        )}
        {canNoShow && (
          <button type="button" onClick={onNoShow} className="h-9 text-caption font-semibold text-destructive">
            {giver ? t("spot.nobodyCame") : t("spot.notThere")}
          </button>
        )}
      </div>
      {giver && !m.arrived_at && <p className="mt-1 text-center text-fine text-muted-foreground">{t("spot.keepOpen")}</p>}
      <Drawer open={talking} onOpenChange={setTalking}>
        <DrawerContent>
          <div className="px-5 pb-8 pt-3">
            <DrawerTitle className="text-center text-tagline font-semibold">{name}</DrawerTitle>
            <DrawerDescription className="sr-only">{t("spot.talk")}</DrawerDescription>
            <NearbyTalk person={person} />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
