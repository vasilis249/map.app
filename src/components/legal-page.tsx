import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";
import { legalDoc } from "@/legal/content";

/** Privacy policy / terms: readable without an account (linked from sign-up, the profile and the App Store page). */
export function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const { t, i18n } = useTranslation();
  const doc = legalDoc(kind, i18n.language);
  return (
    <main className="safe-top mx-auto max-w-2xl px-5 pb-16 pt-4">
      <button type="button" onClick={() => history.back()} className="-ml-2 flex h-11 items-center gap-1 text-callout font-semibold text-link">
        <ChevronLeft className="h-5 w-5" /> {t("common.back")}
      </button>
      <h1 className="mt-2 text-display">{doc.title}</h1>
      <p className="mt-1 text-caption text-muted-foreground">{doc.updated}</p>
      {doc.sections.map((s) => (
        <section key={s.title} className="mt-7">
          <h2 className="text-tagline">{s.title}</h2>
          {s.body.map((p, i) =>
            p.startsWith("• ") ? (
              <p key={i} className="mt-2 pl-4 text-callout leading-relaxed -indent-3">
                • {p.slice(2)}
              </p>
            ) : (
              <p key={i} className="mt-2 text-callout leading-relaxed">
                {p}
              </p>
            ),
          )}
        </section>
      ))}
      <p className="mt-10 text-caption text-muted-foreground">
        <Link to={kind === "privacy" ? "/terms" : "/privacy"} className="font-semibold text-link">
          {t(kind === "privacy" ? "legal.terms" : "legal.privacy")}
        </Link>
      </p>
    </main>
  );
}
