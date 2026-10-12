import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

/**
 * The map's look, after Apple Maps: warm neutral land, soft blue water, gentle greens, white streets with hairline
 * casings, pale-yellow main roads and amber motorways, quiet labels, few icons, soft white 3D buildings. Applied to
 * OpenFreeMap's "liberty" style (free, no key) before MapLibre sees it, so the default colours never flash.
 * One palette per scheme (the iPhone's Light / Dark setting).
 */

interface Palette {
  land: string;
  park: string;
  wood: string;
  grass: string;
  sand: string;
  hospital: string;
  school: string;
  cemetery: string;
  water: string;
  building: string;
  buildingLine: string;
  building3d: string;
  road: string;
  roadCase: string;
  primary: string;
  primaryCase: string;
  motorway: string;
  motorwayCase: string;
  path: string;
  rail: string;
  boundary: string;
  aeroway: string;
  placeLabel: string;
  roadLabel: string;
  poiLabel: string;
  waterLabel: string;
  halo: string;
}

const LIGHT: Palette = {
  land: "#f3f0ea",
  park: "#d3ebc6",
  wood: "#c9e3bb",
  grass: "#d9eecd",
  sand: "#f4ecd6",
  hospital: "#f8e1e1",
  school: "#f1e9d8",
  cemetery: "#dde9d3",
  water: "#a6d2f4",
  building: "#e7e3dc",
  buildingLine: "#dbd6ce",
  building3d: "#f0ede8",
  road: "#ffffff",
  roadCase: "#dcd7cf",
  primary: "#fce7ac",
  primaryCase: "#e9c983",
  motorway: "#f7c560",
  motorwayCase: "#dca447",
  path: "#fbfaf7",
  rail: "#cdc8c0",
  boundary: "#b9b2c8",
  aeroway: "#e9e6ef",
  placeLabel: "#3a3a3c",
  roadLabel: "#6c6c70",
  poiLabel: "#76767b",
  waterLabel: "#4a87bd",
  halo: "#ffffff",
};

const DARK: Palette = {
  land: "#212225",
  park: "#1e3426",
  wood: "#1f3527",
  grass: "#22382a",
  sand: "#2c2a24",
  hospital: "#38292b",
  school: "#2e2b25",
  cemetery: "#24302a",
  water: "#17324b",
  building: "#2b2d31",
  buildingLine: "#34363b",
  building3d: "#323439",
  road: "#3b3d42",
  roadCase: "#2a2b2f",
  primary: "#57503f",
  primaryCase: "#3d382e",
  motorway: "#77603a",
  motorwayCase: "#4e4029",
  path: "#34363a",
  rail: "#45474c",
  boundary: "#5a556a",
  aeroway: "#2a2a30",
  placeLabel: "#e5e5ea",
  roadLabel: "#a1a1a6",
  poiLabel: "#8e8e93",
  waterLabel: "#6ea4d8",
  halo: "#1c1c1e",
};

type AnyLayer = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown> };

function paint(l: AnyLayer, values: Record<string, unknown>) {
  l.paint = { ...(l.paint ?? {}), ...values };
}
function hide(l: AnyLayer) {
  l.layout = { ...(l.layout ?? {}), visibility: "none" };
}

/** Style one layer by its id (liberty's ids: road_*, bridge_*, tunnel_*, label_*, poi_*, …). */
function themeLayer(l: AnyLayer, p: Palette) {
  const id = l.id;
  if (id === "background") return paint(l, { "background-color": p.land });
  // Shaded relief and the residential tint: Apple's land is flat and clean.
  if (id === "natural_earth" || id === "landuse_residential" || id === "park_outline" || id === "road_area_pattern") return hide(l);
  if (id === "park") return paint(l, { "fill-color": p.park, "fill-opacity": 1, "fill-outline-color": p.park });
  if (id === "landcover_wood") return paint(l, { "fill-color": p.wood, "fill-opacity": 0.7 });
  if (id === "landcover_grass" || id === "landuse_pitch" || id === "landuse_track") return paint(l, { "fill-color": p.grass, "fill-opacity": 0.8 });
  if (id === "landcover_sand") return paint(l, { "fill-color": p.sand, "fill-opacity": 1 });
  if (id === "landuse_hospital") return paint(l, { "fill-color": p.hospital, "fill-opacity": 1 });
  if (id === "landuse_school") return paint(l, { "fill-color": p.school, "fill-opacity": 1 });
  if (id === "landuse_cemetery") return paint(l, { "fill-color": p.cemetery, "fill-opacity": 1 });
  if (id === "water") return paint(l, { "fill-color": p.water });
  if (id.startsWith("waterway_") && l.type === "line") return paint(l, { "line-color": p.water });
  if (id === "aeroway_fill") return paint(l, { "fill-color": p.aeroway, "fill-opacity": 1 });
  if (id.startsWith("aeroway_") && l.type === "line") return paint(l, { "line-color": p.roadCase });
  if (id === "building") return paint(l, { "fill-color": p.building, "fill-outline-color": p.buildingLine });
  if (id === "building-3d") return paint(l, { "fill-extrusion-color": p.building3d, "fill-extrusion-opacity": 0.75 });
  if (id.startsWith("boundary")) return paint(l, { "line-color": p.boundary });

  const road = /^(road|bridge|tunnel)_(.+?)(_casing)?$/.exec(id);
  if (road && l.type === "line") {
    const [, kind, cls, casing] = road;
    const tunnel = kind === "tunnel" ? { "line-opacity": 0.55 } : {};
    if (/rail/.test(cls)) return paint(l, { "line-color": p.rail });
    // Footpaths: a quiet solid line (liberty's dashes read as noise), no casing.
    if (/path_pedestrian/.test(cls)) return casing ? hide(l) : paint(l, { "line-color": p.path, "line-dasharray": [1, 0], "line-opacity": 0.8, ...tunnel });
    if (/^motorway/.test(cls)) return paint(l, { "line-color": casing ? p.motorwayCase : p.motorway, ...tunnel });
    if (cls === "trunk_primary") return paint(l, { "line-color": casing ? p.primaryCase : p.primary, ...tunnel });
    return paint(l, { "line-color": casing ? p.roadCase : p.road, ...tunnel });
  }
  if (id.startsWith("road_one_way_arrow")) return paint(l, { "icon-opacity": 0.35 });

  if (l.type !== "symbol") return;
  const halo = { "text-halo-color": p.halo, "text-halo-width": 1.5, "text-halo-blur": 0.5 };
  if (id.startsWith("highway-name")) return paint(l, { "text-color": p.roadLabel, ...halo });
  // Road-number shields only when zoomed out (in town the street names say it).
  if (id.startsWith("highway-shield") || id === "road_shield_us") {
    l.maxzoom = 14;
    return;
  }
  if (id.startsWith("water") || id === "waterway_line_label") return paint(l, { "text-color": p.waterLabel, ...halo });
  if (id.startsWith("label_")) {
    paint(l, { "text-color": p.placeLabel, ...halo, "text-halo-width": 2 });
    // Neighbourhoods quiet, towns and cities bold (Apple's hierarchy).
    if (/city|town|state|country/.test(id)) l.layout = { ...(l.layout ?? {}), "text-font": ["Noto Sans Bold"] };
    else l.layout = { ...(l.layout ?? {}), "text-font": ["Noto Sans Regular"] };
    return;
  }
  if (id.startsWith("poi_") || id === "airport") {
    paint(l, { "text-color": p.poiLabel, ...halo });
    l.layout = { ...(l.layout ?? {}), "text-font": ["Noto Sans Regular"] };
    // Fewer icons: shops and cafés only when you are close in.
    const later: Record<string, number> = { poi_r1: 16, poi_r7: 17, poi_r20: 18 };
    if (later[id]) l.minzoom = later[id];
  }
}

/** A copy of the liberty style in this app's look. */
export function themeStyle(base: StyleSpecification, dark: boolean): StyleSpecification {
  const style = JSON.parse(JSON.stringify(base)) as StyleSpecification;
  const p = dark ? DARK : LIGHT;
  for (const l of style.layers as AnyLayer[]) themeLayer(l, p);
  // Soft, high light: 3D buildings get gentle shading instead of dark walls.
  style.light = { anchor: "viewport", color: "#ffffff", intensity: dark ? 0.15 : 0.2, position: [1.2, 210, 25] };
  return style;
}
