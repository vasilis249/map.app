import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Briefcase, Clock, House, Loader2, MapPin, type LucideIcon } from "lucide-react";
import { useDriving } from "@/hooks/use-driving";
import { NavApiError, searchPlaces } from "@/lib/nav/api";
import type { LatLng } from "@/lib/nav/geo";
import type { Place } from "@/lib/nav/route";
import { addRecent, readSaved, setShortcut } from "@/lib/nav/saved-places";

/**
 * Destination search: type, pick. Suggestions come as you type (debounced, nearest to you first). Not while driving:
 * typing at speed is exactly what the App Store's driving rules and common sense forbid — but Home, Work and recent
 * places are one tap, so those stay (Waze). They're kept on the device only.
 */
export function NavSearch({ near, onPick, onClose }: { near: LatLng | null; onPick: (p: Place) => void; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const driving = useDriving();
  const [saved, setSaved] = useState(readSaved);
  // Choosing the address for Home / Work: the next pick is saved instead of driven to.
  const [setting, setSetting] = useState<"home" | "work" | null>(null);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]);
  // Results depend on where you are only roughly (the server rounds to ≈ 1 km too).
  const nearKey = near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : "-";
  const places = useQuery({
    queryKey: ["nav", "search", q, nearKey, i18n.language],
    queryFn: ({ signal }) => searchPlaces(q, near, i18n.language, signal),
    enabled: q.length >= 2 && !driving,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const err = places.error instanceof NavApiError ? places.error.code : places.error ? "unavailable" : null;
  const pick = (p: Place) => {
    if (setting) {
      setShortcut(setting, p);
      setSaved(readSaved());
      setSetting(null);
      setText("");
      return;
    }
    addRecent(p);
    onPick(p);
  };
  const startSetting = (which: "home" | "work") => {
    setSetting(which);
    setText("");
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)]" role="dialog" aria-label={t("nav.whereTo")}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button type="button" onClick={onClose} aria-label={t("common.back")} className="grid h-11 w-11 place-items-center rounded-full">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <input
          autoFocus={!driving}
          disabled={driving}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={100}
          enterKeyHint="search"
          placeholder={setting ? t(setting === "home" ? "nav.pickHome" : "nav.pickWork") : t("nav.searchPlaceholder")}
          aria-label={setting ? t(setting === "home" ? "nav.pickHome" : "nav.pickWork") : t("nav.searchPlaceholder")}
          className="h-11 min-w-0 flex-1 rounded-full bg-secondary px-4 text-body outline-none disabled:opacity-50"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {driving || (q.length < 2 && !setting) ? (
          <>
            {driving && <p className="py-6 text-center text-callout font-semibold">{t("nav.stopToType")}</p>}
            <ul className="pt-2" aria-label={t("nav.shortcuts")}>
              <Shortcut icon={House} label={t("nav.home")} place={saved.home} onGo={pick} onSet={driving ? null : () => startSetting("home")} />
              <Shortcut icon={Briefcase} label={t("nav.work")} place={saved.work} onGo={pick} onSet={driving ? null : () => startSetting("work")} />
            </ul>
            {saved.recent.length > 0 && (
              <>
                <p className="mt-5 text-caption font-semibold uppercase tracking-wide text-muted-foreground">{t("nav.recent")}</p>
                <ul aria-label={t("nav.recent")}>
                  {saved.recent.map((p) => (
                    <li key={p.id}>
                      <PlaceRow icon={Clock} place={p} onClick={() => pick(p)} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!driving && <p className="py-6 text-center text-caption text-muted-foreground">{t("nav.searchHint")}</p>}
          </>
        ) : q.length < 2 ? (
          <p className="py-8 text-center text-caption text-muted-foreground">{t(setting === "home" ? "nav.pickHome" : "nav.pickWork")}</p>
        ) : places.isFetching && !places.data ? (
          <p className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </p>
        ) : err ? (
          <p className="py-8 text-center text-caption font-semibold text-destructive">{t(`nav.errors.${err}`)}</p>
        ) : places.data?.length === 0 ? (
          <p className="py-8 text-center text-caption text-muted-foreground">{t("nav.noPlaces")}</p>
        ) : (
          <ul>
            {places.data?.map((p) => (
              <li key={p.id}>
                <PlaceRow icon={MapPin} place={p} onClick={() => pick(p)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PlaceRow({ icon: Icon, place, onClick }: { icon: LucideIcon; place: Place; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 border-b border-border/60 py-3 text-left">
      <span className="glass-tile grid h-10 w-10 shrink-0 place-items-center rounded-full">
        <Icon className="h-5 w-5 text-link" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-semibold">{place.name}</span>
        {place.detail && <span className="block truncate text-caption text-muted-foreground">{place.detail}</span>}
      </span>
    </button>
  );
}

/** Home / Work: one tap drives there; "Ορισμός" / "Αλλαγή" picks the address (not while driving). */
function Shortcut({
  icon: Icon,
  label,
  place,
  onGo,
  onSet,
}: {
  icon: LucideIcon;
  label: string;
  place: Place | null;
  onGo: (p: Place) => void;
  onSet: (() => void) | null;
}) {
  const { t } = useTranslation();
  if (!place && !onSet) return null;
  return (
    <li className="flex items-center gap-2 border-b border-border/60">
      <button
        type="button"
        onClick={() => (place ? onGo(place) : onSet?.())}
        aria-label={place ? `${label}: ${place.name}` : t("nav.setShortcut", { label })}
        className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-link text-white">
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block font-semibold">{label}</span>
          <span className="block truncate text-caption text-muted-foreground">{place ? place.name : t("nav.setShortcut", { label })}</span>
        </span>
      </button>
      {place && onSet && (
        <button type="button" onClick={onSet} className="h-9 shrink-0 rounded-full px-3 text-caption font-semibold text-link">
          {t("nav.change")}
        </button>
      )}
    </li>
  );
}
