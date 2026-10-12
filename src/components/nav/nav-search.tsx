import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Loader2, MapPin } from "lucide-react";
import { useDriving } from "@/hooks/use-driving";
import { NavApiError, searchPlaces } from "@/lib/nav/api";
import type { LatLng } from "@/lib/nav/geo";
import type { Place } from "@/lib/nav/route";

/**
 * Destination search: type, pick. Suggestions come as you type (debounced, nearest to you first). Not while driving:
 * typing at speed is exactly what the App Store's driving rules and common sense forbid.
 */
export function NavSearch({ near, onPick, onClose }: { near: LatLng | null; onPick: (p: Place) => void; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const driving = useDriving();
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
          placeholder={t("nav.searchPlaceholder")}
          aria-label={t("nav.searchPlaceholder")}
          className="h-11 min-w-0 flex-1 rounded-full bg-secondary px-4 text-body outline-none disabled:opacity-50"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {driving ? (
          <p className="py-8 text-center text-callout font-semibold">{t("nav.stopToType")}</p>
        ) : q.length < 2 ? (
          <p className="py-8 text-center text-caption text-muted-foreground">{t("nav.searchHint")}</p>
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
                <button type="button" onClick={() => onPick(p)} className="flex w-full items-center gap-3 border-b border-border/60 py-3 text-left">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-secondary">
                    <MapPin className="h-5 w-5 text-link" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{p.name}</span>
                    {p.detail && <span className="block truncate text-caption text-muted-foreground">{p.detail}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
