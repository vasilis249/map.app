import type { CustomLayerInterface, Map as MlMap } from "maplibre-gl";
import type * as THREE from "three";

/**
 * People around you in 3D while navigating, like a Tesla's screen: a small car for someone moving at vehicle speed in
 * the last 5 minutes (server flag `in_vehicle`), else a pedestrian. Soft monochrome models (white-grey; friends
 * green-tinted; someone talking to you coral), lit like the map's 3D buildings. Cheap Lambert materials and
 * low-poly shapes: a dozen figures cost next to nothing per frame. A MapLibre custom layer drawing with
 * three.js on the map's own WebGL context; three.js is loaded only when navigation starts. Figures glide to each new
 * position (people's positions arrive every couple of seconds) and turn smoothly to their direction.
 */

export interface Figure {
  id: string;
  lat: number;
  lng: number;
  /** Degrees from north, or null (keeps the last one / derived from movement). */
  heading: number | null;
  vehicle: boolean;
  tint: "friend" | "other" | "talking";
}

export const PEOPLE_3D_LAYER = "people-3d";
/** Models are drawn larger than life so they read on a phone (a 4.5 m car would be ~20 px at zoom 18). */
const CAR_SIZE = 1.7;
const PED_SIZE = 2.4;
const GLIDE_MS = 1_500;

const COLORS = { other: 0xe6e8ec, friend: 0xa9e3b8, talking: 0xff7a66 };
const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const turn = (a: number, b: number) => ((b - a + 540) % 360) - 180;

export async function createPeople3d(ml: typeof import("maplibre-gl")): Promise<{
  layer: CustomLayerInterface;
  set(list: Figure[]): void;
  /** Figures currently drawn (tests). */
  count(): number;
}> {
  const T = await import("three");
  const { RoundedBoxGeometry } = await import("three/addons/geometries/RoundedBoxGeometry.js");

  // --- models (metres; forward = -z = north at rotation 0, up = +y) ---
  const glass = new T.MeshLambertMaterial({ color: 0x4a5560 });
  const tyre = new T.MeshLambertMaterial({ color: 0x26272b });
  const bodyGeo = new RoundedBoxGeometry(1.85, 0.72, 4.5, 2, 0.28);
  const cabinGeo = new RoundedBoxGeometry(1.62, 0.56, 2.4, 2, 0.24);
  const wheelGeo = new T.CylinderGeometry(0.34, 0.34, 0.26, 12).rotateZ(Math.PI / 2);
  const torsoGeo = new T.CapsuleGeometry(0.24, 0.9, 3, 10);
  const headGeo = new T.SphereGeometry(0.17, 12, 8);

  function car(paint: THREE.Material) {
    const g = new T.Group();
    const body = new T.Mesh(bodyGeo, paint);
    body.position.y = 0.62;
    const cabin = new T.Mesh(cabinGeo, glass);
    cabin.position.set(0, 1.2, 0.25);
    g.add(body, cabin);
    for (const [x, z] of [[0.86, -1.42], [-0.86, -1.42], [0.86, 1.42], [-0.86, 1.42]]) {
      const w = new T.Mesh(wheelGeo, tyre);
      w.position.set(x, 0.34, z);
      g.add(w);
    }
    return g;
  }
  function pedestrian(paint: THREE.Material) {
    const g = new T.Group();
    const torso = new T.Mesh(torsoGeo, paint);
    torso.position.y = 0.7;
    const head = new T.Mesh(headGeo, paint);
    head.position.y = 1.6;
    g.add(torso, head);
    return g;
  }

  const scene = new T.Scene();
  scene.add(new T.HemisphereLight(0xffffff, 0x9a9a9a, 2.2));
  const sun = new T.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-30, 80, 40);
  scene.add(sun);
  const camera = new T.Camera();
  let renderer: THREE.WebGLRenderer | null = null;
  let map: MlMap | null = null;

  interface Entry {
    fig: Figure;
    obj: THREE.Group;
    kind: string;
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    at: number;
    heading: number;
    shown: number;
  }
  const entries = new Map<string, Entry>();
  const materials = {
    other: new T.MeshLambertMaterial({ color: COLORS.other }),
    friend: new T.MeshLambertMaterial({ color: COLORS.friend }),
    talking: new T.MeshLambertMaterial({ color: COLORS.talking, emissive: 0x5a1a10 }),
  };

  function now() {
    return performance.now();
  }
  function where(e: Entry, t: number) {
    const k = Math.min(1, (t - e.at) / GLIDE_MS);
    const s = k * k * (3 - 2 * k); // ease in-out
    return { lat: e.from.lat + (e.to.lat - e.from.lat) * s, lng: e.from.lng + (e.to.lng - e.from.lng) * s };
  }

  function set(list: Figure[]) {
    const t = now();
    const seen = new Set<string>();
    for (const f of list) {
      seen.add(f.id);
      const kind = `${f.vehicle ? "car" : "ped"}:${f.tint}`;
      let e = entries.get(f.id);
      if (e && e.kind !== kind) {
        scene.remove(e.obj);
        e = { ...e, obj: (f.vehicle ? car : pedestrian)(materials[f.tint]), kind };
        scene.add(e.obj);
        entries.set(f.id, e);
      }
      if (!e) {
        const obj = (f.vehicle ? car : pedestrian)(materials[f.tint]);
        scene.add(obj);
        e = { fig: f, obj, kind, from: f, to: f, at: t, heading: f.heading ?? 0, shown: t };
        entries.set(f.id, e);
      } else if (e.to.lat !== f.lat || e.to.lng !== f.lng) {
        const cur = where(e, t);
        // No heading from the server: face the way they moved (if they moved enough to tell).
        if (f.heading == null) {
          const dy = (f.lat - cur.lat) * 110_574;
          const dx = (f.lng - cur.lng) * 111_320 * Math.cos(rad(f.lat));
          if (Math.hypot(dx, dy) > 2) e.fig = { ...f, heading: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 };
          else e.fig = { ...f, heading: e.fig.heading };
        } else e.fig = f;
        e.from = cur;
        e.to = f;
        e.at = t;
      } else e.fig = { ...f, heading: f.heading ?? e.fig.heading };
      e.obj.scale.setScalar(f.vehicle ? CAR_SIZE : PED_SIZE);
    }
    for (const [id, e] of entries)
      if (!seen.has(id)) {
        scene.remove(e.obj);
        entries.delete(id);
      }
    map?.triggerRepaint();
  }

  const layer: CustomLayerInterface = {
    id: PEOPLE_3D_LAYER,
    type: "custom",
    renderingMode: "3d",
    onAdd(m, gl) {
      map = m;
      renderer = new T.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    onRemove() {
      renderer?.dispose();
      renderer = null;
      map = null;
    },
    render(_gl, args) {
      if (!renderer || !map || entries.size === 0) return;
      const t = now();
      const c = map.getCenter();
      // One origin (the map centre) for the frame; every figure is placed in metres from it.
      const kx = Math.cos(rad(c.lat)) * (Math.PI / 180) * R;
      const ky = (Math.PI / 180) * R;
      let moving = false;
      for (const e of entries.values()) {
        const p = where(e, t);
        if (t - e.at < GLIDE_MS) moving = true;
        e.obj.position.set((p.lng - c.lng) * kx, 0, -(p.lat - c.lat) * ky);
        const target = e.fig.heading ?? e.heading;
        const d = turn(e.heading, target);
        if (Math.abs(d) > 0.5) {
          e.heading = (e.heading + d * 0.12 + 360) % 360;
          moving = true;
        }
        e.obj.rotation.y = -rad(e.heading);
      }
      const o = ml.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0);
      const mc = { x: o.x, y: o.y, z: o.z, s: o.meterInMercatorCoordinateUnits() };
      const view = new T.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
      const model = new T.Matrix4()
        .makeTranslation(mc.x, mc.y, mc.z)
        .scale(new T.Vector3(mc.s, -mc.s, mc.s))
        .multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(1, 0, 0), Math.PI / 2));
      camera.projectionMatrix = view.multiply(model);
      renderer.resetState();
      renderer.render(scene, camera);
      if (moving) map.triggerRepaint();
    },
  };

  return { layer, set, count: () => entries.size };
}
