/** "80 μ" / "3,1 χλμ" (rounded to 10 m, never below 10 m). */
export function formatDistance(m: number, lang: string) {
  const en = lang.startsWith("en");
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} ${en ? "m" : "μ"}`;
  return `${(m / 1000).toLocaleString(lang, { maximumFractionDigits: 1 })} ${en ? "km" : "χλμ"}`;
}
