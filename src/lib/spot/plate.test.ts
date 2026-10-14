import { describe, expect, it } from "vitest";
import { formatPlate, normalizePlate, plateOk } from "./plate";

describe("licence plates", () => {
  it("normalizes like the server: Greek look-alikes → Latin, no spaces / dashes, upper case", () => {
    expect(normalizePlate("ΙΚΑ-1234")).toBe("IKA1234");
    expect(normalizePlate(" zkp 4521 ")).toBe("ZKP4521");
    expect(normalizePlate("ικα·1234")).toBe("IKA1234");
  });
  it("accepts 4–8 letters and digits with at least one of each", () => {
    expect(plateOk("ΙΚΑ-1234")).toBe(true);
    expect(plateOk("ΑΒ 123")).toBe(true);
    expect(plateOk("12")).toBe(false);
    expect(plateOk("ΓΔΘΛ")).toBe(false); // letters that aren't on Greek plates (no Latin twin) and no digit
    expect(plateOk("1234567")).toBe(false);
    expect(plateOk("IKA1234; DROP")).toBe(false);
  });
  it("shows it back in Greek with a dash", () => {
    expect(formatPlate("IKA1234")).toBe("ΙΚΑ-1234");
    expect(formatPlate("ZKP4521")).toBe("ΖΚΡ-4521");
    expect(formatPlate("AB12C")).toBe("ΑΒ12C"); // not letters-then-digits: left as is
  });
});
