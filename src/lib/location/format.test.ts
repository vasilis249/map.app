import { describe, expect, it } from "vitest";
import { formatDistance } from "./format";
import { metres } from "./tracker";

describe("distances", () => {
  it("formats metres (10 m steps, never below 10) and kilometres per language", () => {
    expect(formatDistance(3, "el")).toBe("10 μ");
    expect(formatDistance(184, "el")).toBe("180 μ");
    expect(formatDistance(184, "en")).toBe("180 m");
    expect(formatDistance(3140, "el")).toBe("3,1 χλμ");
    expect(formatDistance(3140, "en")).toBe("3.1 km");
  });

  it("haversine agrees with the server's (≈100 m for 0.0009° of latitude in Athens)", () => {
    const d = metres({ lat: 37.9755, lng: 23.7348 }, { lat: 37.9764, lng: 23.7348 });
    expect(d).toBeGreaterThan(99);
    expect(d).toBeLessThan(101);
  });
});
