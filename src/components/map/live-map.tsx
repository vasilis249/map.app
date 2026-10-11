import { useEffect, useRef } from "react";
import type { ExpressionSpecification, Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 draws the map (streets, buildings, labels) in a web worker it loads from a file next to its own script,
// which the app bundle doesn't have: without this the map shows no streets at all. Bundle the worker ourselves.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { avatarUrl } from "@/lib/avatar";
import type { MapPerson } from "@/lib/location/api";

/**
 * The live map, like Snap Map / Find My: a normal street map (OpenFreeMap "liberty", free, no key), you as your photo
 * with a blue ring, an accuracy halo and a direction beam (compass, or your course while moving), everyone else as a
 * round photo with their first name (green ring = friend, pulsing coral = talking to you, faded + "20λ" = last known
 * position) and a light halo when their fix is not sharp. Markers glide to new positions instead of jumping.
 * Optional radius circle (the "Κοντά μου" view). MapLibre is loaded on demand; markers are plain DOM elements.
 */

/** Street map that follows the iPhone's Light / Dark setting (DESIGN.md: liberty by day, dark at night). */
const STYLES = { light: "https://tiles.openfreemap.org/styles/liberty", dark: "https://tiles.openfreemap.org/styles/dark" };
const darkMedia = () => (typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)"));
const styleUrl = () => (darkMedia()?.matches ? STYLES.dark : STYLES.light);
/** A colour token from design-system.css (the map's own layers can't read CSS variables). */
const token = (name: string, fallback: string) =>
  (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;
const ATHENS: [number, number] = [23.7275, 37.9838];
const ME_ZOOM = 16;

/**
 * Place and street names in the app's language (the style shows "Latin / local" pairs): Greek → the local name
 * (Greek in Greece), English → the English name, else the Latin transliteration, else the local one.
 */
function localizeLabels(m: MlMap, lang: string) {
  const name: ExpressionSpecification = lang.startsWith("en")
    ? ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]]
    : ["coalesce", ["get", "name:el"], ["get", "name"], ["get", "name:latin"]];
  for (const layer of m.getStyle()?.layers ?? []) {
    if (layer.type !== "symbol") continue;
    const field = m.getLayoutProperty(layer.id, "text-field");
    if (field && JSON.stringify(field).includes('"name')) m.setLayoutProperty(layer.id, "text-field", name);
  }
}

export interface LivePosition {
  lat: number;
  lng: number;
  accuracy?: number | null;
  /** From this device right now (else: the last position you shared, from the server). */
  live?: boolean;
}

/** Where to move the camera: yourself, your radius, or a point (a friend). Change `key` to move again. */
export interface MapFocus {
  key: number;
  target: "me" | "radius" | { lat: number; lng: number };
}

function circle(center: LivePosition, radiusM: number, steps = 72): [number, number][] {
  const pts: [number, number][] = [];
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    pts.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return pts;
}

function face(name: string, path: string | null, className: string): HTMLElement {
  const el = document.createElement("span");
  el.className = `grid place-items-center overflow-hidden rounded-full bg-secondary font-semibold text-foreground ${className}`;
  const url = avatarUrl(path);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.className = "h-full w-full object-cover";
    el.appendChild(img);
  } else {
    el.textContent = (name || "?").trim().charAt(0).toUpperCase();
  }
  return el;
}

const GLIDE_MS = 900;

/** Move a marker smoothly to its new position (a big jump — e.g. the first real fix — is not animated). */
function glide(marker: Marker & { __anim?: number }, to: [number, number]) {
  const from = marker.getLngLat();
  if (marker.__anim) cancelAnimationFrame(marker.__anim);
  const far = Math.abs(from.lng - to[0]) > 0.02 || Math.abs(from.lat - to[1]) > 0.02;
  if (far || (from.lng === to[0] && from.lat === to[1])) {
    marker.setLngLat(to);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / GLIDE_MS);
    const e = 1 - (1 - k) ** 3;
    marker.setLngLat([from.lng + (to[0] - from.lng) * e, from.lat + (to[1] - from.lat) * e]);
    marker.__anim = k < 1 ? requestAnimationFrame(step) : undefined;
  };
  marker.__anim = requestAnimationFrame(step);
}

function personElement(p: MapPerson, talking: boolean, age: string | null, onSelect: (p: MapPerson) => void): HTMLElement {
  const name = p.full_name || p.username;
  const wrap = document.createElement("div");
  wrap.className = `relative h-12 w-12 ${age && !talking ? "opacity-60" : ""}`;
  if (talking) wrap.dataset.talking = "1";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", name);
  btn.className = "block h-12 w-12 rounded-full";
  btn.appendChild(
    face(
      name,
      p.avatar_path,
      `h-12 w-12 border-[3px] text-body ${
        talking ? "animate-pulse border-live ring-4 ring-live/40" : age ? "border-muted-foreground" : p.is_friend ? "border-success" : "border-white"
      }`,
    ),
  );
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onSelect(p);
  });
  const label = document.createElement("span");
  label.className =
    "pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap glass rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-semibold text-foreground";
  label.textContent = age ? `${name.split(" ")[0]} · ${age}` : name.split(" ")[0];
  wrap.append(btn, label);
  return wrap;
}

/** You: photo in a blue ring with a soft ping, and a direction beam (hidden until a heading is known). */
function meElement(name: string, path: string | null): { el: HTMLElement; beam: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.setAttribute("aria-label", "me");
  wrap.className = "relative grid h-12 w-12 place-items-center";
  const beam = document.createElement("span");
  beam.dataset.beam = "1";
  beam.className = "pointer-events-none absolute left-1/2 top-1/2 hidden h-28 w-28 -translate-x-1/2 -translate-y-1/2";
  beam.style.background = "conic-gradient(from -28deg, rgba(10,132,255,0.45), rgba(10,132,255,0) 56deg, transparent 56deg)";
  beam.style.maskImage = "radial-gradient(circle, #000 18%, transparent 70%)";
  beam.style.webkitMaskImage = beam.style.maskImage;
  beam.style.borderRadius = "9999px";
  const pulse = document.createElement("span");
  pulse.className = "absolute inset-0 animate-ping rounded-full bg-primary/30";
  wrap.append(beam, pulse, face(name, path, "relative h-11 w-11 border-[3px] border-primary text-body"));
  return { el: wrap, beam };
}

export function LiveMap({
  me,
  meFace,
  radius,
  people,
  onSelect,
  focus,
  talking,
  heading,
  ageOf,
  lang,
}: {
  me: LivePosition | null;
  meFace: { name: string; path: string | null };
  /** Draw this radius around you (the nearby view), or null. */
  radius: number | null;
  people: MapPerson[];
  onSelect: (p: MapPerson) => void;
  focus: MapFocus | null;
  /** People talking to you right now. */
  talking: string[];
  /** Where you point (degrees from north), or null. */
  heading: number | null;
  /** "20λ" for a last known (old) position, null when it is current. */
  ageOf: (p: MapPerson) => string | null;
  /** App language, for place names. */
  lang: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const lib = useRef<typeof import("maplibre-gl") | null>(null);
  const markers = useRef(new Map<string, { marker: Marker; sig: string }>());
  const meMarker = useRef<{ marker: Marker; sig: string; beam: HTMLElement } | null>(null);
  const styleReady = useRef(false);
  // Where the camera was first put: on your stored position, then again on your live one when it arrives (unless you
  // already moved the map yourself).
  const placed = useRef<"none" | "stored" | "live">("none");
  const userMoved = useRef(false);
  const schemeOff = useRef<(() => void) | null>(null);
  const latest = useRef({ me, meFace, radius, people, onSelect, talking, ageOf, lang });
  latest.current = { me, meFace, radius, people, onSelect, talking, ageOf, lang };

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    const all = markers.current;
    void import("maplibre-gl").then((ml) => {
      if (cancelled || !box.current) return;
      if (ml.getWorkerUrl() !== maplibreWorkerUrl) ml.setWorkerUrl(maplibreWorkerUrl);
      lib.current = ml;
      const start = latest.current.me;
      const m = new ml.Map({
        container: box.current,
        style: styleUrl(),
        center: start ? [start.lng, start.lat] : ATHENS,
        zoom: start ? ME_ZOOM : 11,
        attributionControl: { compact: true },
        pitchWithRotate: false,
        dragRotate: false,
      });
      m.touchZoomRotate.disableRotation();
      const byUser = (e: { originalEvent?: unknown }) => {
        if (e.originalEvent) userMoved.current = true;
      };
      m.on("dragstart", byUser);
      m.on("zoomstart", byUser);
      // Our layers go on top of whichever style is loaded (the first one, and again after a Light / Dark switch).
      m.on("style.load", () => {
        styleReady.current = true;
        localizeLabels(m, latest.current.lang);
        const blue = token("--link", "#0066cc");
        const empty = { type: "FeatureCollection" as const, features: [] };
        m.addSource("radius", { type: "geojson", data: empty });
        m.addLayer({ id: "radius-fill", type: "fill", source: "radius", paint: { "fill-color": blue, "fill-opacity": 0.08 } });
        m.addLayer({ id: "radius-line", type: "line", source: "radius", paint: { "line-color": blue, "line-width": 1.5, "line-opacity": 0.8 } });
        m.addSource("people-acc", { type: "geojson", data: empty });
        m.addLayer({ id: "people-acc-fill", type: "fill", source: "people-acc", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.12 } });
        m.addLayer({ id: "people-acc-line", type: "line", source: "people-acc", paint: { "line-color": ["get", "color"], "line-width": 1, "line-opacity": 0.35 } });
        m.addSource("me-acc", { type: "geojson", data: empty });
        m.addLayer({ id: "me-acc-fill", type: "fill", source: "me-acc", paint: { "fill-color": blue, "fill-opacity": 0.12 } });
        m.addLayer({ id: "me-acc-line", type: "line", source: "me-acc", paint: { "line-color": blue, "line-width": 1, "line-opacity": 0.4 } });
        drawAreas();
      });
      const media = darkMedia();
      const onScheme = () => {
        styleReady.current = false;
        m.setStyle(styleUrl());
      };
      media?.addEventListener("change", onScheme);
      schemeOff.current = () => media?.removeEventListener("change", onScheme);
      map.current = m;
      sync();
    });
    return () => {
      cancelled = true;
      schemeOff.current?.();
      map.current?.remove();
      map.current = null;
      all.clear();
      meMarker.current = null;
      styleReady.current = false;
      placed.current = "none";
      userMoved.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function drawAreas() {
    const m = map.current;
    const { me: pos, radius: r, people: list } = latest.current;
    if (!m || !styleReady.current) return;
    const poly = (ring: [number, number][], props: Record<string, string> = {}) => ({
      type: "Feature",
      properties: props,
      geometry: { type: "Polygon", coordinates: [ring] },
    });
    const set = (id: string, features: unknown[]) =>
      (m.getSource(id) as { setData: (d: unknown) => void } | undefined)?.setData({ type: "FeatureCollection", features });
    set("radius", pos && r ? [poly(circle(pos, r))] : []);
    set("me-acc", pos?.accuracy && pos.accuracy > 15 ? [poly(circle(pos, Math.min(pos.accuracy, 5000), 48))] : []);
    // A light halo around people whose fix is not sharp (like Find My's grey circle).
    set(
      "people-acc",
      list
        .filter((p) => p.accuracy_m != null && p.accuracy_m > 20)
        .map((p) => poly(circle(p, Math.min(p.accuracy_m!, 5000), 36), { color: p.is_friend ? token("--success", "#34c759") : token("--muted-foreground", "#6e6e73") })),
    );
  }

  function frameRadius(animate: boolean) {
    const m = map.current;
    const { me: pos, radius: r } = latest.current;
    if (!m || !pos || !r) return;
    const ring = circle(pos, r, 16);
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const cam = m.cameraForBounds([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)], { padding: 56 });
    if (!cam) return;
    // A jump while the style may still be loading (an animated move would never finish then).
    if (animate) m.easeTo({ ...cam, duration: 600 });
    else m.jumpTo(cam);
  }

  function sync() {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml) return;
    const { me: pos, meFace: mf, radius: r, people: list, onSelect: select, talking: live, ageOf: age } = latest.current;
    // you
    if (pos) {
      const sig = `${mf.name}|${mf.path}`;
      if (!meMarker.current || meMarker.current.sig !== sig) {
        meMarker.current?.marker.remove();
        const { el, beam } = meElement(mf.name, mf.path);
        meMarker.current = { marker: new ml.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(m), sig, beam };
        pointBeam();
      } else glide(meMarker.current.marker, [pos.lng, pos.lat]);
      const kind = pos.live ? "live" : "stored";
      if (placed.current === "none" || (placed.current === "stored" && kind === "live" && !userMoved.current)) {
        placed.current = kind;
        if (r) frameRadius(false);
        else m.jumpTo({ center: [pos.lng, pos.lat], zoom: ME_ZOOM });
      }
    }
    // everyone else
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.user_id);
      const talks = live.includes(p.user_id);
      const old = age(p);
      const sig = `${p.avatar_path}|${p.is_friend}|${p.full_name}|${talks}|${old}`;
      const cur = markers.current.get(p.user_id);
      if (cur && cur.sig === sig) {
        glide(cur.marker, [p.lng, p.lat]);
        continue;
      }
      const at = cur ? cur.marker.getLngLat() : null;
      cur?.marker.remove();
      const marker = new ml.Marker({ element: personElement(p, talks, old, select) }).setLngLat(at ? [at.lng, at.lat] : [p.lng, p.lat]).addTo(m);
      if (at) glide(marker, [p.lng, p.lat]);
      markers.current.set(p.user_id, { marker, sig });
    }
    for (const [id, { marker }] of markers.current) {
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
    drawAreas();
  }

  // Language switched while the map is open.
  useEffect(() => {
    if (map.current && styleReady.current) localizeLabels(map.current, lang);
  }, [lang]);

  const talkingKey = talking.join();
  useEffect(sync, [me?.lat, me?.lng, me?.accuracy, me?.live, meFace.name, meFace.path, people, radius, talkingKey]);

  // The beam on your marker follows the compass (or your course).
  const headingRef = useRef(heading);
  headingRef.current = heading;
  function pointBeam() {
    const b = meMarker.current?.beam;
    if (!b) return;
    const h = headingRef.current;
    b.classList.toggle("hidden", h == null);
    if (h != null) b.style.transform = `translate(-50%, -50%) rotate(${h}deg)`;
  }
  useEffect(pointBeam, [heading]);

  // Camera requests: back to you, your radius, or a friend.
  useEffect(() => {
    const m = map.current;
    if (!focus || !m) return;
    const t = focus.target;
    if (t === "radius") return frameRadius(true);
    const pos = t === "me" ? latest.current.me : t;
    if (!pos) return;
    m.flyTo({ center: [pos.lng, pos.lat], zoom: Math.max(m.getZoom(), ME_ZOOM), duration: 900 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  // MapLibre makes its container position: relative, so it gets its own full-size box inside the absolute one.
  return (
    <div className="absolute inset-0">
      <div ref={box} className="h-full w-full" />
    </div>
  );
}
