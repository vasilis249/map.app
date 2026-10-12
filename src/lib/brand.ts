/**
 * App name and identifiers in one place. PLACEHOLDERS until the name / bundle id decision (CLAUDE.md → Decisions):
 * change here, in capacitor.config.ts (CAP_APP_ID), ios/App/App/Info.plist and wrangler.jsonc.
 */
export const APP_NAME = "MapApp";
/** Custom URL scheme (auth email deep links) and the localStorage key prefix. */
export const APP_SLUG = "mapapp";

/**
 * Who runs the service (privacy policy, terms). PLACEHOLDERS — the owner fills in the legal entity; the texts are
 * drafts for a lawyer to review (src/legal/content.ts).
 */
export const LEGAL = {
  entity: "[ΕΠΩΝΥΜΙΑ ΕΤΑΙΡΕΙΑΣ]",
  address: "[ΔΙΕΥΘΥΝΣΗ]",
  email: "[EMAIL ΕΠΙΚΟΙΝΩΝΙΑΣ]",
  courts: "[ΠΟΛΗ]",
  updated: "2026-10-12",
};
