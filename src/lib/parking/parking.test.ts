import { describe, expect, it } from "vitest";
import { offset } from "@/lib/nav/geo";
import { carStale, droveOff, freeNear, type ParkingSpot } from "./parking";

const car = { lat: 37.97, lng: 23.73, at: 0 };
const spot = (id: string, m: number, state: "free" | "taken" = "free", mine = false): ParkingSpot => ({
  id,
  state,
  mine,
  updated_at: "",
  expires_at: "",
  ...offset(car, m, 90),
});

describe("parking", () => {
  it("asks 'did you free your spot?' only when driving off from where you parked (40–400 m, > 15 km/h, same day)", () => {
    expect(droveOff(car, { ...offset(car, 100, 0), speed: 8 }, 60_000)).toBe(true);
    expect(droveOff(car, { ...offset(car, 100, 0), speed: 1.2 }, 60_000)).toBe(false); // walking back to it
    expect(droveOff(car, { ...offset(car, 10, 0), speed: 8 }, 60_000)).toBe(false); // still at it
    expect(droveOff(car, { ...offset(car, 2_000, 0), speed: 8 }, 60_000)).toBe(false); // long gone (another trip)
    expect(droveOff(car, { ...offset(car, 100, 0), speed: 8 }, 25 * 3_600_000)).toBe(false); // parked yesterday
    expect(droveOff(null, { ...offset(car, 100, 0), speed: 8 }, 60_000)).toBe(false);
    expect(carStale(car, 25 * 3_600_000)).toBe(true);
    expect(carStale(car, 3_600_000)).toBe(false);
  });
  it("free spots near the destination: others' green ones within 300 m, nearest first", () => {
    const list = [spot("far", 500), spot("b", 200), spot("a", 50), spot("red", 20, "taken"), spot("mine", 30, "free", true)];
    expect(freeNear(list, car).map((x) => x.spot.id)).toEqual(["a", "b"]);
    expect(freeNear(list, car)[0].distance).toBeCloseTo(50, 0);
  });
});
