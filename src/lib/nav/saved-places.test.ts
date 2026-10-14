import { describe, expect, it } from "vitest";
import type { Place } from "./route";
import { MAX_RECENT, withRecent } from "./saved-places";

const place = (id: string, lat: number, lng = 23.73): Place => ({ id, name: id, detail: "", lat, lng });

describe("recent destinations", () => {
  it("newest first; the same place again moves to the top instead of repeating (same id or within 30 m)", () => {
    let list: Place[] = [];
    list = withRecent(list, place("a", 37.97));
    list = withRecent(list, place("b", 37.98));
    list = withRecent(list, place("a", 37.97));
    expect(list.map((p) => p.id)).toEqual(["a", "b"]);
    list = withRecent(list, place("b-again", 37.98015));
    expect(list.map((p) => p.id)).toEqual(["b-again", "a"]);
  });
  it("keeps at most 8", () => {
    let list: Place[] = [];
    for (let i = 0; i < 12; i++) list = withRecent(list, place(`p${i}`, 37.9 + i * 0.01));
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].id).toBe("p11");
  });
});
