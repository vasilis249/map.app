import { useEffect, useRef } from "react";
import type { ExpressionSpecification, Map as MlMap, Marker, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 draws the map (streets, buildings, labels) in a web worker it loads from a file next to its own script,
// which the app bundle doesn't have: without this the map shows no streets at all. Bundle the worker ourselves.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { avatarUrl } from "@/lib/avatar";
import { themeStyle } from "./map-theme";
import type { Motion } from "@/lib/nav/motion";
import { createPeople3d, PEOPLE_3D_LAYER, type Figure } from "./people-3d";
import { ROAD_ICON_PATHS } from "./road-icons";
import type { MapPerson } from "@/lib/location/api";

/**
 * The live map, like Snap Map / Find My: a normal street map (OpenFreeMap "liberty", free, no key), you as your photo
 * with a blue ring, an accuracy halo and a direction beam (compass, or your course while moving), everyone else as a
 * round photo with their first name (green ring = friend, pulsing coral = talking to you, faded + "20λ" = last known
 * position) and a light halo when their fix is not sharp. Markers glide to new positions instead of jumping.
 * Optional radius circle (the "Κοντά μου" view). MapLibre is loaded on demand; markers are plain DOM elements.
 */

/**
 * Street map that follows the iPhone's Light / Dark setting: OpenFreeMap's "liberty" recoloured after Apple Maps
 * (map-theme.ts) in both schemes. If the style can't be fetched for the recolouring, MapLibre loads the plain one.
 */
const LIBERTY = "https://tiles.openfreemap.org/styles/liberty";
const darkMedia = () => (typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)"));
let libertyJson: Promise<StyleSpecification | null> | null = null;
async function mapStyle(): Promise<StyleSpecification | string> {
  libertyJson ??= fetch(LIBERTY)
    .then((r) => (r.ok ? (r.json() as Promise<StyleSpecification>) : null))
    .catch(() => null);
  const base = await libertyJson;
  if (!base) libertyJson = null; // try again next time
  return base ? themeStyle(base, !!darkMedia()?.matches) : LIBERTY;
}
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

/** Navigation on the map (P4): the route(s), the destination, and how the camera behaves. */
export interface MapNav {
  /** Routes as [lng, lat] lines; `chosen` is drawn on top, the others are tappable alternatives. */
  lines: [number, number][][];
  chosen: number;
  dest: { lat: number; lng: number };
  /** preview: frame the routes once; follow: heading-up, tilted camera that follows you (until you move the map). */
  mode: "preview" | "follow";
  /** Direction to face in follow mode (your course, else the route's). */
  bearing: number | null;
  /** Follow mode: smooth 60 fps arrow + camera between fixes (lib/nav/motion.ts); the line is trimmed behind you. */
  motion?: Motion | null;
  /** Traffic reported on the route ahead (P7): stretches drawn over the line, 1 moderate · 2 heavy · 3 standstill. */
  traffic?: { level: 1 | 2 | 3; coords: [number, number][] }[];
  onChoose?: (i: number) => void;
}

const NAV_ZOOM = 17;
const NAV_PITCH = 50;

function flagElement(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-label", "destination");
  el.className = "grid h-10 w-10 place-items-center rounded-full border-[3px] border-white bg-destructive text-white shadow-float";
  el.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/></svg>';
  return el;
}

/** A road report on the map (Waze-style pin). */
export interface MapRoad {
  id: string;
  kind: keyof typeof ROAD_ICON_PATHS;
  lat: number;
  lng: number;
}
const ROAD_COLORS: Record<MapRoad["kind"], string> = {
  accident: "#ff3b30",
  police: "#0a84ff",
  hazard: "#ff9f0a",
  traffic: "#ff6a00",
  closed: "#c4001a",
  camera: "#5e5ce6",
  help: "#30b0c7",
};

/** A parking spot (P7): green = just freed, red = taken. */
export interface MapParking {
  id: string;
  state: "free" | "taken";
  lat: number;
  lng: number;
}

function parkingElement(p: MapParking, label: string, onSelect: (id: string) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.dataset.parking = p.state;
  btn.className = "grid h-8 w-8 place-items-center rounded-lg border-2 border-white text-[15px] font-extrabold text-white shadow-float";
  btn.style.background = p.state === "free" ? "#30d158" : "#ff3b30";
  btn.textContent = "P";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onSelect(p.id);
  });
  return btn;
}

function roadElement(r: MapRoad, label: string, onSelect: (id: string) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.dataset.road = r.kind;
  btn.className = "grid h-9 w-9 place-items-center rounded-full border-2 border-white text-white shadow-float";
  btn.style.background = ROAD_COLORS[r.kind];
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ROAD_ICON_PATHS[r.kind]}</svg>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onSelect(r.id);
  });
  return btn;
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

function personElement(p: MapPerson, talking: boolean, age: string | null, onSelect: (p: MapPerson) => void, compact = false): HTMLElement {
  const name = p.full_name || p.username;
  const wrap = document.createElement("div");
  wrap.className = `relative h-12 w-12 ${age && !talking ? "opacity-60" : ""}`;
  if (talking) wrap.dataset.talking = "1";
  // Compact while navigating: a small photo floating above their 3D car / figure, no name tag. (The scale goes on an
  // inner box: on the marker element itself it would also scale MapLibre's positioning transform.)
  const inner = document.createElement("div");
  inner.className = `relative h-12 w-12 ${compact ? "scale-[0.7]" : ""}`;
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
  inner.append(btn);
  if (!compact) inner.append(label);
  wrap.append(inner);
  return wrap;
}

/**
 * You while navigating: the navigation arrow (like Apple / Google Maps) — a blue chevron with a white edge and a soft
 * shadow, lying flat on the tilted map and turned to your direction of travel.
 */
function puckElement(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-label", "me");
  el.dataset.puck = "1";
  el.className = "pointer-events-none h-14 w-14";
  el.style.filter = "drop-shadow(0 3px 4px rgba(0,0,0,0.35))";
  el.innerHTML =
    '<svg viewBox="0 0 56 56" width="56" height="56" aria-hidden="true">' +
    '<defs><linearGradient id="puck-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4aa3ff"/><stop offset="1" stop-color="#0a66f0"/></linearGradient></defs>' +
    '<path d="M28 5 L47 48 L28 38.5 L9 48 Z" fill="url(#puck-g)" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>' +
    "</svg>";
  return el;
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
  nav = null,
  roads = [],
  roadLabel = (k) => k,
  onSelectRoad = () => {},
  parking = [],
  parkingLabel = (s) => s,
  onSelectParking = () => {},
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
  /** Navigation (route lines, destination, follow camera), or null. */
  nav?: MapNav | null;
  /** Road reports to show (Waze-style pins); tapping one calls onSelectRoad. */
  roads?: MapRoad[];
  roadLabel?: (kind: MapRoad["kind"]) => string;
  onSelectRoad?: (id: string) => void;
  /** Parking spots (green free / red taken); tapping one calls onSelectParking. */
  parking?: MapParking[];
  parkingLabel?: (state: MapParking["state"]) => string;
  onSelectParking?: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const lib = useRef<typeof import("maplibre-gl") | null>(null);
  const markers = useRef(new Map<string, { marker: Marker; sig: string }>());
  const meMarker = useRef<{ marker: Marker; sig: string; beam: HTMLElement | null } | null>(null);
  const styleReady = useRef(false);
  // Where the camera was first put: on your stored position, then again on your live one when it arrives (unless you
  // already moved the map yourself).
  const placed = useRef<"none" | "stored" | "live">("none");
  const userMoved = useRef(false);
  const schemeOff = useRef<(() => void) | null>(null);
  const latest = useRef({ me, meFace, radius, people, onSelect, talking, ageOf, lang, nav, roads, roadLabel, onSelectRoad, parking, parkingLabel, onSelectParking });
  latest.current = { me, meFace, radius, people, onSelect, talking, ageOf, lang, nav, roads, roadLabel, onSelectRoad, parking, parkingLabel, onSelectParking };
  const parkingMarkers = useRef(new Map<string, { marker: Marker; sig: string }>());
  const roadMarkers = useRef(new Map<string, { marker: Marker; sig: string }>());
  const destMarker = useRef<Marker | null>(null);
  // Follow mode paused because you moved the map yourself (the recenter button resumes it).
  const navFree = useRef(false);
  const framedKey = useRef<string | null>(null);
  // The 3D people layer (three.js, loaded on the first navigation).
  const people3d = useRef<{ api: Awaited<ReturnType<typeof createPeople3d>> } | null>(null);
  const people3dLoading = useRef(false);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    const all = markers.current;
    const roadPins = roadMarkers.current;
    const parkPins = parkingMarkers.current;
    void Promise.all([import("maplibre-gl"), mapStyle()]).then(([ml, style]) => {
      if (cancelled || !box.current) return;
      if (ml.getWorkerUrl() !== maplibreWorkerUrl) ml.setWorkerUrl(maplibreWorkerUrl);
      lib.current = ml;
      const start = latest.current.me;
      const m = new ml.Map({
        container: box.current,
        style,
        center: start ? [start.lng, start.lat] : ATHENS,
        zoom: start ? ME_ZOOM : 11,
        attributionControl: { compact: true },
        pitchWithRotate: false,
        // The close 3D view at a red light tilts past MapLibre's default 60°.
        maxPitch: 70,
        dragRotate: false,
      });
      m.touchZoomRotate.disableRotation();
      const byUser = (e: { originalEvent?: unknown }) => {
        if (e.originalEvent) userMoved.current = true;
      };
      m.on("dragstart", byUser);
      m.on("zoomstart", byUser);
      m.on("dragstart", (e: { originalEvent?: unknown }) => {
        if (e.originalEvent && latest.current.nav?.mode === "follow") navFree.current = true;
      });
      m.on("rotate", () => pointBeam());
      // The camera's state, for tests and debugging (heading-up while navigating).
      m.on("moveend", () => {
        if (!box.current) return;
        box.current.dataset.bearing = String(Math.round(m.getBearing()));
        box.current.dataset.pitch = String(Math.round(m.getPitch()));
      });
      // Tap an alternative route to choose it.
      m.on("click", "nav-alt", (e) => {
        const idx = e.features?.[0]?.properties?.idx;
        if (typeof idx === "number") latest.current.nav?.onChoose?.(idx);
      });
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
        // Routes above every street, bridge and building, under the names (labels stay readable).
        const layers = m.getStyle().layers;
        const lastShape = layers.reduce((at, l, i) => (l.type === "symbol" ? at : i), -1);
        const labels = layers.slice(lastShape + 1).find((l) => l.type === "symbol")?.id;
        m.addSource("nav", { type: "geojson", data: empty });
        const line = { "line-join": "round", "line-cap": "round" } as const;
        // Apple-like: a bright blue line with a darker edge, thicker as you zoom in; alternatives pale blue.
        const width = (k: number): ExpressionSpecification => ["interpolate", ["exponential", 1.5], ["zoom"], 10, 3 * k, 15, 7 * k, 18, 16 * k];
        m.addLayer({ id: "nav-alt-casing", type: "line", source: "nav", filter: ["==", ["get", "chosen"], false], layout: line, paint: { "line-color": "#6f97d6", "line-width": width(1.35) } }, labels);
        m.addLayer({ id: "nav-alt", type: "line", source: "nav", filter: ["==", ["get", "chosen"], false], layout: line, paint: { "line-color": "#a9c7f5", "line-width": width(1) } }, labels);
        m.addLayer({ id: "nav-casing", type: "line", source: "nav", filter: ["==", ["get", "chosen"], true], layout: line, paint: { "line-color": "#0b5bd3", "line-width": width(1.4) } }, labels);
        m.addLayer({ id: "nav-line", type: "line", source: "nav", filter: ["==", ["get", "chosen"], true], layout: line, paint: { "line-color": "#2b8bff", "line-width": width(1) } }, labels);
        // Traffic on the route (Waze / Google colours), over the blue line.
        m.addSource("nav-traffic", { type: "geojson", data: empty });
        m.addLayer({ id: "nav-traffic", type: "line", source: "nav-traffic", layout: line, paint: { "line-color": ["match", ["get", "level"], 1, "#ff9f0a", 2, "#ff3b30", "#a3161a"], "line-width": width(0.72) } }, labels);
        drawTraffic();
        drawAreas();
        drawNav();
      });
      const media = darkMedia();
      const onScheme = () => {
        styleReady.current = false;
        void mapStyle().then((next) => m.setStyle(next));
      };
      media?.addEventListener("change", onScheme);
      schemeOff.current = () => media?.removeEventListener("change", onScheme);
      map.current = m;
      // Tests / debugging only: the map instance, when this device opted in (localStorage "mapapp:debugMap").
      try {
        if (localStorage.getItem("mapapp:debugMap") === "1") (window as unknown as { __map?: MlMap }).__map = m;
      } catch {
        // storage blocked: no debug hook
      }
      sync();
    });
    return () => {
      cancelled = true;
      schemeOff.current?.();
      map.current?.remove();
      map.current = null;
      all.clear();
      roadPins.forEach(({ marker }) => marker.remove());
      roadPins.clear();
      parkPins.forEach(({ marker }) => marker.remove());
      parkPins.clear();
      if (loop.current != null) cancelAnimationFrame(loop.current);
      loop.current = null;
      meMarker.current = null;
      destMarker.current = null;
      framedKey.current = null;
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
    const following = latest.current.nav?.mode === "follow";
    set("me-acc", !following && pos?.accuracy && pos.accuracy > 15 ? [poly(circle(pos, Math.min(pos.accuracy, 5000), 48))] : []);
    // A light halo around people whose fix is not sharp (like Find My's grey circle).
    set(
      "people-acc",
      list
        .filter((p) => p.accuracy_m != null && p.accuracy_m > 20)
        .map((p) => poly(circle(p, Math.min(p.accuracy_m!, 5000), 36), { color: p.is_friend ? token("--success", "#34c759") : token("--muted-foreground", "#6e6e73") })),
    );
  }

  function drawTraffic() {
    const m = map.current;
    if (!m || !styleReady.current) return;
    const list = latest.current.nav?.traffic ?? [];
    (m.getSource("nav-traffic") as { setData: (d: unknown) => void } | undefined)?.setData({
      type: "FeatureCollection",
      features: list.map((j) => ({ type: "Feature", properties: { level: j.level }, geometry: { type: "LineString", coordinates: j.coords } })),
    });
    if (box.current) box.current.dataset.jams = list.map((j) => j.level).join(",");
  }

  function drawNav() {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml) return;
    // Your marker: the navigation arrow while following a route, your photo otherwise.
    const wantPuck = latest.current.nav?.mode === "follow";
    if (meMarker.current && (meMarker.current.sig === "puck") !== wantPuck) {
      meMarker.current.marker.remove();
      meMarker.current = null;
      sync();
    }
    const n = latest.current.nav;
    if (styleReady.current)
      (m.getSource("nav") as { setData: (d: unknown) => void } | undefined)?.setData({
        type: "FeatureCollection",
        features: (n?.lines ?? []).map((coords, idx) => ({
          type: "Feature",
          properties: { idx, chosen: idx === n!.chosen },
          geometry: { type: "LineString", coordinates: coords },
        })),
      });
    if (n) {
      if (!destMarker.current) destMarker.current = new ml.Marker({ element: flagElement(), anchor: "center" }).setLngLat([n.dest.lng, n.dest.lat]).addTo(m);
      else destMarker.current.setLngLat([n.dest.lng, n.dest.lat]);
    } else {
      destMarker.current?.remove();
      destMarker.current = null;
    }
    navCamera();
    if (n?.mode === "follow" && n.motion) followLoop();
    show3d(n?.mode === "follow");
  }

  /** Put the 3D people layer on the map while following a route (loading three.js the first time), off otherwise. */
  function show3d(on: boolean) {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml || !styleReady.current) return;
    const has = !!m.getLayer(PEOPLE_3D_LAYER);
    if (!on) {
      if (has) m.removeLayer(PEOPLE_3D_LAYER);
      people3d.current?.api.set([]);
      return;
    }
    if (has) return;
    if (people3d.current) {
      m.addLayer(people3d.current.api.layer);
      sync();
      return;
    }
    if (people3dLoading.current) return;
    people3dLoading.current = true;
    void createPeople3d(ml)
      .then((api) => {
        people3d.current = { api };
        show3d(latest.current.nav?.mode === "follow");
      })
      .catch(() => undefined)
      .finally(() => (people3dLoading.current = false));
  }

  /** Preview: frame all routes once. Follow: you, low on the screen, facing your way, tilted. Off: flat again. */
  function navCamera() {
    const m = map.current;
    const n = latest.current.nav;
    const pos = latest.current.me;
    if (!m) return;
    if (!n) {
      if (framedKey.current) {
        framedKey.current = null;
        navFree.current = false;
        m.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
      }
      return;
    }
    if (n.mode === "preview") {
      const key = `p:${n.lines.length}:${n.dest.lat},${n.dest.lng}`;
      if (framedKey.current === key || !n.lines.length) return;
      framedKey.current = key;
      const all = n.lines.flat();
      if (pos) all.push([pos.lng, pos.lat]);
      const lngs = all.map((c) => c[0]);
      const lats = all.map((c) => c[1]);
      const cam = m.cameraForBounds([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)], {
        // (the route choices card, the map buttons and the tab bar cover the lower half)
        padding: { top: 70, bottom: m.getContainer().clientHeight * 0.55, left: 40, right: 40 },
      });
      if (cam) m.jumpTo({ ...cam, pitch: 0, bearing: 0 });
      return;
    }
    framedKey.current = "follow";
    if (n.motion) return; // the frame loop (followLoop) moves the camera
    if (navFree.current || !pos) return;
    const h = m.getContainer().clientHeight;
    m.easeTo({
      center: [pos.lng, pos.lat],
      zoom: NAV_ZOOM,
      pitch: NAV_PITCH,
      bearing: n.bearing ?? m.getBearing(),
      padding: { top: h * 0.3, bottom: h * 0.2, left: 0, right: 0 },
      duration: 900,
      essential: true,
    });
  }

  /**
   * Following a route: every animation frame, the arrow and the camera go where the motion model says (one jumpTo per
   * frame — no overlapping animations fighting each other), and a few times a second the route line is trimmed to
   * what's ahead of the arrow. Stops by itself when navigation ends.
   */
  const loop = useRef<number | null>(null);
  function followLoop() {
    if (loop.current != null) return;
    let n = 0;
    let lastCam: { lat: number; lng: number; bearing: number; zoom: number; pitch: number } | null = null;
    const tick = () => {
      const m = map.current;
      const nav = latest.current.nav;
      if (!m || nav?.mode !== "follow" || !nav.motion) {
        loop.current = null;
        return;
      }
      loop.current = requestAnimationFrame(tick);
      const f = nav.motion.frame(Date.now());
      if (!f) return;
      const mk = meMarker.current;
      if (mk?.sig === "puck") mk.marker.setLngLat([f.lng, f.lat]).setRotation(f.bearing);
      // Nothing moved (standing at a light, settled): no new frame — the map stays idle and saves battery.
      const prevCam = lastCam;
      lastCam = f;
      const settled =
        prevCam &&
        Math.abs(prevCam.lat - f.lat) < 1e-7 &&
        Math.abs(prevCam.lng - f.lng) < 1e-7 &&
        Math.abs(prevCam.bearing - f.bearing) < 0.05 &&
        Math.abs(prevCam.zoom - f.zoom) < 0.002 &&
        Math.abs(prevCam.pitch - f.pitch) < 0.05;
      if (!navFree.current && !settled) {
        const h = m.getContainer().clientHeight;
        // You sit a little below the middle of what's visible between the banner (top) and the controls (bottom),
        // so more of the road ahead shows.
        m.jumpTo({ center: [f.lng, f.lat], zoom: f.zoom, pitch: f.pitch, bearing: f.bearing, padding: { top: h * 0.3, bottom: h * 0.2, left: 0, right: 0 } });
      }
      if (++n % 12 === 0) {
        const ahead = nav.motion.ahead();
        if (ahead && styleReady.current)
          (m.getSource("nav") as { setData: (d: unknown) => void } | undefined)?.setData({
            type: "FeatureCollection",
            features: [{ type: "Feature", properties: { idx: 0, chosen: true }, geometry: { type: "LineString", coordinates: ahead } }],
          });
        if (box.current) {
          box.current.dataset.zoom = f.zoom.toFixed(1);
          box.current.dataset.frames = String(n);
          box.current.dataset.figures = String(m.getLayer(PEOPLE_3D_LAYER) ? (people3d.current?.api.count() ?? 0) : 0);
        }
      }
    };
    loop.current = requestAnimationFrame(tick);
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
      const puck = latest.current.nav?.mode === "follow";
      const sig = puck ? "puck" : `${mf.name}|${mf.path}`;
      if (!meMarker.current || meMarker.current.sig !== sig) {
        meMarker.current?.marker.remove();
        if (puck) {
          // Lies on the map and turns with it: rotation is your course in map degrees.
          const marker = new ml.Marker({ element: puckElement(), rotationAlignment: "map", pitchAlignment: "map" });
          meMarker.current = { marker: marker.setLngLat([pos.lng, pos.lat]).addTo(m), sig, beam: null };
        } else {
          const { el, beam } = meElement(mf.name, mf.path);
          meMarker.current = { marker: new ml.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(m), sig, beam };
        }
        pointBeam();
      } else if (!(puck && latest.current.nav?.motion)) glide(meMarker.current.marker, [pos.lng, pos.lat]);
      const kind = pos.live ? "live" : "stored";
      if (placed.current === "none" || (placed.current === "stored" && kind === "live" && !userMoved.current)) {
        placed.current = kind;
        if (r) frameRadius(false);
        else m.jumpTo({ center: [pos.lng, pos.lat], zoom: ME_ZOOM });
      }
    }
    // everyone else (while navigating: also as 3D cars / pedestrians)
    const following3d = latest.current.nav?.mode === "follow";
    people3d.current?.api.set(
      following3d
        ? list
            .filter((p) => p.lat || p.lng)
            .map((p): Figure => ({ id: p.user_id, lat: p.lat, lng: p.lng, heading: p.heading, vehicle: !!p.in_vehicle, tint: live.includes(p.user_id) ? "talking" : p.is_friend ? "friend" : "other" }))
        : [],
    );
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.user_id);
      const talks = live.includes(p.user_id);
      const old = age(p);
      const sig = `${p.avatar_path}|${p.is_friend}|${p.full_name}|${talks}|${old}|${following3d}`;
      const cur = markers.current.get(p.user_id);
      if (cur && cur.sig === sig) {
        glide(cur.marker, [p.lng, p.lat]);
        continue;
      }
      const at = cur ? cur.marker.getLngLat() : null;
      cur?.marker.remove();
      const marker = new ml.Marker({ element: personElement(p, talks, old, select, following3d), offset: following3d ? [0, -42] : [0, 0] })
        .setLngLat(at ? [at.lng, at.lat] : [p.lng, p.lat])
        .addTo(m);
      if (at) glide(marker, [p.lng, p.lat]);
      markers.current.set(p.user_id, { marker, sig });
    }
    for (const [id, { marker }] of markers.current) {
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
    drawRoads();
    drawParking();
    drawAreas();
    navCamera();
  }

  /** Parking pins (plain DOM markers). */
  function drawParking() {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml) return;
    const { parking: list, parkingLabel: label } = latest.current;
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      const sig = `${p.state}|${p.lat}|${p.lng}`;
      const cur = parkingMarkers.current.get(p.id);
      if (cur?.sig === sig) continue;
      cur?.marker.remove();
      const marker = new ml.Marker({ element: parkingElement(p, label(p.state), (id) => latest.current.onSelectParking(id)) }).setLngLat([p.lng, p.lat]).addTo(m);
      parkingMarkers.current.set(p.id, { marker, sig });
    }
    for (const [id, { marker }] of parkingMarkers.current)
      if (!seen.has(id)) {
        marker.remove();
        parkingMarkers.current.delete(id);
      }
  }

  /** Road report pins (plain DOM markers, like the people). */
  function drawRoads() {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml) return;
    const { roads: list, roadLabel: label } = latest.current;
    const seen = new Set<string>();
    for (const r of list) {
      seen.add(r.id);
      const sig = `${r.kind}|${r.lat}|${r.lng}`;
      const cur = roadMarkers.current.get(r.id);
      if (cur?.sig === sig) continue;
      cur?.marker.remove();
      const marker = new ml.Marker({ element: roadElement(r, label(r.kind), (id) => latest.current.onSelectRoad(id)) }).setLngLat([r.lng, r.lat]).addTo(m);
      roadMarkers.current.set(r.id, { marker, sig });
    }
    for (const [id, { marker }] of roadMarkers.current)
      if (!seen.has(id)) {
        marker.remove();
        roadMarkers.current.delete(id);
      }
  }

  // Language switched while the map is open.
  useEffect(() => {
    if (map.current && styleReady.current) localizeLabels(map.current, lang);
  }, [lang]);

  const talkingKey = talking.join();
  useEffect(sync, [me?.lat, me?.lng, me?.accuracy, me?.live, meFace.name, meFace.path, people, radius, talkingKey]);
  const roadsKey = roads.map((r) => `${r.id}${r.kind}`).join();
  useEffect(drawRoads, [roadsKey]);
  const parkingKey = parking.map((p) => `${p.id}${p.state}${p.lat}`).join();
  useEffect(drawParking, [parkingKey]);
  const navKey = nav ? `${nav.mode}|${nav.chosen}|${nav.lines.length}|${nav.lines[nav.chosen]?.length}|${nav.lines[nav.chosen]?.[0]?.join()}|${nav.dest.lat},${nav.dest.lng}` : "";
  const trafficKey = (nav?.traffic ?? []).map((j) => `${j.level}:${j.coords.length}:${j.coords[0]?.join()}`).join("|");
  useEffect(drawTraffic, [trafficKey]);
  // (drawNav reads everything else from `latest`; it re-runs when the route, its mode or the destination change)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(drawNav, [navKey]);

  // The beam on your marker follows the compass (or your course).
  const headingRef = useRef(heading);
  headingRef.current = heading;
  function pointBeam() {
    const cur = meMarker.current;
    const h = headingRef.current;
    if (cur && !cur.beam) {
      // The navigation arrow: turned in map degrees (MapLibre adds the map's own rotation); with a motion model the
      // frame loop turns it.
      if (h != null && !latest.current.nav?.motion) cur.marker.setRotation(h);
      return;
    }
    const b = cur?.beam;
    if (!b) return;
    b.classList.toggle("hidden", h == null);
    // The beam points on the screen: subtract the map's own rotation (heading-up while navigating).
    if (h != null) b.style.transform = `translate(-50%, -50%) rotate(${h - (map.current?.getBearing() ?? 0)}deg)`;
  }
  useEffect(pointBeam, [heading]);

  // Camera requests: back to you, your radius, or a friend.
  useEffect(() => {
    const m = map.current;
    if (!focus || !m) return;
    const t = focus.target;
    if (t === "radius") return frameRadius(true);
    // While following you on a route, "me" resumes the follow camera.
    if (t === "me" && latest.current.nav?.mode === "follow") {
      navFree.current = false;
      return navCamera();
    }
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
