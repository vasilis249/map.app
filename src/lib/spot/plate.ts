/**
 * Licence plates (P8): stored the way the server stores them — the Greek letters that look Latin (Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ
 * Τ Υ Χ) as those Latin letters, no spaces / dashes — and shown back in Greek with a dash ("ΙΚΑ-1234"), as on the car.
 */
const GREEK = "ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ";
const LATIN = "ABEZHIKMNOPTYX";

export function normalizePlate(p: string): string {
  let out = "";
  for (const ch of p.toUpperCase()) {
    const i = GREEK.indexOf(ch);
    out += i >= 0 ? LATIN[i] : ch;
  }
  return out.replace(/[\s\-·.]/g, "");
}

/** 4–8 letters / digits, at least one of each (as the server checks). */
export function plateOk(p: string): boolean {
  const n = normalizePlate(p);
  return /^[A-Z0-9]{4,8}$/.test(n) && /[0-9]/.test(n) && /[A-Z]/.test(n);
}

/** "IKA1234" → "ΙΚΑ-1234" (Greek letters where they exist, a dash between the letters and the digits). */
export function formatPlate(stored: string): string {
  let out = "";
  for (const ch of stored) {
    const i = LATIN.indexOf(ch);
    out += i >= 0 ? GREEK[i] : ch;
  }
  return out.replace(/^([^\d]+)(\d+)$/, "$1-$2");
}

export const COLOURS = ["white", "black", "grey", "silver", "blue", "red", "green", "yellow", "orange", "brown", "beige", "other"] as const;
export type Colour = (typeof COLOURS)[number];
export const COLOUR_HEX: Record<Colour, string> = {
  white: "#ffffff",
  black: "#111111",
  grey: "#8e8e93",
  silver: "#c7c7cc",
  blue: "#0a84ff",
  red: "#ff3b30",
  green: "#30d158",
  yellow: "#ffd60a",
  orange: "#ff9f0a",
  brown: "#8b5a2b",
  beige: "#e8d8b8",
  other: "linear-gradient(135deg,#ff3b30,#ffd60a,#30d158,#0a84ff)",
};
