import type { TFunction } from "i18next";

/** "12 λ", "1 ώ 05 λ". */
export function formatDuration(seconds: number, t: TFunction): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return t("nav.min", { count: min });
  return t("nav.hoursMin", { h: Math.floor(min / 60), m: String(min % 60).padStart(2, "0") });
}

/** Clock time of arrival ("14:32"). */
export function arrivalTime(etaSeconds: number, lang: string, now = Date.now()): string {
  // Greek clocks read 24-hour ("14:32", not "02:32 μ.μ.").
  return new Date(now + etaSeconds * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", hourCycle: lang.startsWith("el") ? "h23" : undefined });
}

/** A distance for the voice ("400 μέτρα", "1,5 χιλιόμετρα"), already rounded by spokenMetres. */
export function spokenDistance(m: number, t: TFunction, lang: string): string {
  if (m < 1000) return t("nav.say.metres", { count: m });
  const km = m / 1000;
  return t("nav.say.km", { count: km === 1 ? 1 : 2, km: km.toLocaleString(lang, { maximumFractionDigits: 1 }) });
}
