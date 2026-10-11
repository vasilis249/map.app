const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "5 λεπτά πριν" / "2 hr. ago" style, for posts, comments and notifications. */
export function timeAgo(iso: string, locale: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return rtf.format(-Math.floor(seconds / size), unit);
  }
  return rtf.format(0, "second");
}

const SHORT = {
  el: { now: "τώρα", m: "λ", h: "ω", d: "η" },
  en: { now: "now", m: "m", h: "h", d: "d" },
} as const;

/** Compact age for feed rows (X-style): "τώρα", "5λ", "2ω", "3η", then the date ("12 Σεπ"). */
export function timeAgoShort(iso: string, locale: string): string {
  const u = SHORT[locale.startsWith("en") ? "en" : "el"];
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return u.now;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}${u.m}`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}${u.h}`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}${u.d}`;
  const d = new Date(iso);
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}
