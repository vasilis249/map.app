import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Volume2 } from "lucide-react";
import { toast } from "sonner";
import { VoiceIcon } from "@/components/voice/voice-icon";
import { SafetyGate } from "@/components/talk/safety-notice";
import { HistoryRow } from "@/components/walkie/history-row";
import { useDriving } from "@/hooks/use-driving";
import type { WalkieItem } from "@/lib/walkie/history";
import { useAuth } from "@/hooks/use-auth";
import { useWalkie } from "@/hooks/use-walkie";
import { formatClock } from "@/lib/audio";
import type { MapPerson } from "@/lib/location/api";
import { NEAR_M } from "@/lib/location/near";
import { holdNearby, nearbyAudio, nearbyHistory, nearbyKeys, nearbyKnock, rememberNearby } from "@/lib/location/nearby";
import { WALKIE_MAX_MS } from "@/lib/walkie/engine";
import { cn } from "@/lib/utils";

function knockError(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (m.includes("too_many_people")) return "nearby.tooManyPeople";
  if (m.includes("rate_limited")) return "rpcErrors.rateLimited";
  if (m.includes("not_nearby")) return "nearby.notNearby";
  return "errors.generic";
}

/**
 * Push to talk to someone on the map: hold and speak, they hear you live (their phone joins when the server approves
 * your knock; your first words wait here until then). Their answers play here too, and the last 24 h are below.
 */
export function NearbyTalk({ person, onReport }: { person: MapPerson; onReport?: (item: WalkieItem) => void }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const driving = useDriving();
  const qc = useQueryClient();
  const peer = person.user_id;
  const name = person.full_name || person.username;
  const first = name.split(" ")[0];

  useEffect(() => {
    rememberNearby({ user_id: peer, username: person.username, full_name: person.full_name, avatar_path: person.avatar_path, distance_m: person.distance_m });
  }, [peer, person.username, person.full_name, person.avatar_path, person.distance_m]);

  const history = useQuery({ queryKey: nearbyKeys.history(peer), queryFn: () => nearbyHistory(peer) });
  // No channel at all with someone you can't talk to (it would be refused anyway).
  const w = useWalkie(
    person.can_talk ? user?.id : undefined,
    peer,
    {
      onSaved: () => void qc.invalidateQueries({ queryKey: nearbyKeys.history(peer) }),
      onYield: () => toast(t("walkie.yielded", { name: first })),
    },
    "nearby",
  );
  const s = w.snap;

  // Press → the mic starts and the voice is held here; then the knock: approved → it goes out, refused → stops.
  const held = useRef(false);
  const [denied, setDenied] = useState(false);
  const shake = () => {
    setDenied(true);
    setTimeout(() => setDenied(false), 900);
  };
  async function down(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 || held.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    held.current = true;
    if (s?.peerTalking) return shake();
    let approve!: () => void;
    let refuse!: (e: unknown) => void;
    const gate = new Promise<void>((res, rej) => {
      approve = res;
      refuse = rej;
    });
    gate.catch(() => {}); // handled by the session and below
    const ok = await w.press(gate);
    if (!ok) {
      refuse(new Error("not_started"));
      if (!held.current) toast(t("walkie.holdForBeep")); // let go before the mic was ready
      return;
    }
    holdNearby(peer); // keep the conversation open for their answer
    nearbyKnock(peer).then(approve, (err) => {
      refuse(err);
      held.current = false;
      shake();
      toast.error(t(knockError(err), { name: first }));
      void qc.invalidateQueries({ queryKey: ["location", "people"] });
    });
    if (!held.current) w.release();
  }
  function up() {
    if (!held.current) return;
    held.current = false;
    w.release();
  }

  const status = !person.can_talk
    ? person.distance_m > NEAR_M
      ? t("nearby.tooFar")
      : t("nearby.cantTalk", { name: first })
    : !s || !s.connected
      ? s?.error === "channel"
        ? t("walkie.cantConnect")
        : t("walkie.connecting")
      : s.talking
        ? s.waiting
          ? t("nearby.calling", { name: first })
          : t("walkie.onAir")
        : s.starting
          ? t("walkie.starting")
          : s.peerTalking
            ? t("walkie.peerTalking", { name: first })
            : s.waiting
              ? t("nearby.stillCalling", { name: first })
              : s.peerOnline
                ? t("walkie.peerHere", { name: first })
                : t("nearby.hold");

  const disabled = !person.can_talk || !s?.connected;
  const items = history.data ?? [];
  return (
    <div className="mt-5 flex flex-col items-center">
      <p className={cn("h-5 text-center text-caption", s?.peerTalking || s?.talking ? "font-semibold text-live" : "text-muted-foreground")}>{status}</p>
      {s?.audioLocked && s.peerTalking && (
        <button type="button" onClick={w.unlockAudio} className="mt-2 flex h-9 items-center gap-2 rounded-full bg-secondary px-4 text-caption font-semibold">
          <Volume2 className="h-4 w-4" /> {t("walkie.enableSound")}
        </button>
      )}
      <SafetyGate>
        {/* One large target, usable by feel (no reading while driving). */}
        <div className="relative mt-3 grid h-44 w-44 place-items-center">
          {s?.talking && (
            <svg className="pointer-events-none absolute inset-0 -rotate-90" viewBox="0 0 176 176" aria-hidden>
              <circle
                cx="88" cy="88" r="85" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="text-live"
                strokeDasharray={2 * Math.PI * 85} strokeDashoffset={2 * Math.PI * 85 * (1 - Math.min(1, s.elapsedMs / WALKIE_MAX_MS))}
              />
            </svg>
          )}
          <button
            type="button"
            // The card is a bottom sheet: holding to talk must never start dragging the sheet.
            data-vaul-no-drag=""
            disabled={disabled}
            onPointerDown={(e) => void down(e)}
            onPointerUp={up}
            onPointerCancel={up}
            onLostPointerCapture={up}
            onContextMenu={(e) => e.preventDefault()}
            style={{ WebkitTouchCallout: "none", touchAction: "none" }}
            aria-label={t("nearby.hold")}
            className={cn(
              "grid h-36 w-36 place-items-center rounded-full transition-transform duration-150 disabled:opacity-40",
              s?.talking || s?.starting
                ? "scale-105 bg-live text-destructive-foreground"
                : s?.peerTalking
                  ? "bg-secondary text-muted-foreground"
                  : "bg-primary text-primary-foreground",
              denied && "animate-shake",
            )}
          >
            <VoiceIcon className="h-14 w-14" strokeWidth={1.8} live={!!s?.talking || !!s?.peerTalking} />
          </button>
        </div>
      </SafetyGate>
      <p className="mt-1 h-5 text-caption tabular-nums text-muted-foreground">{s?.talking ? `${formatClock(s.elapsedMs)} / ${formatClock(WALKIE_MAX_MS)}` : ""}</p>

      {items.length > 0 && !driving && (
        <section className="mt-3 w-full">
          <h3 className="pb-1 text-callout font-semibold text-muted-foreground">{t("walkie.last24h")}</h3>
          <ul className="max-h-40 divide-y divide-border overflow-y-auto">
            {items.map((m) => (
              <HistoryRow
                key={m.id}
                item={m}
                mine={m.sender_id === user?.id}
                name={first}
                locale={i18n.language}
                load={nearbyAudio}
                onReport={onReport && (() => onReport(m))}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
