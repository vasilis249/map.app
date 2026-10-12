import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { APP_SLUG } from "@/lib/brand";

const KEY = `${APP_SLUG}:talkSafetyOk`;

function acknowledged(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Shown once, before the first push-to-talk: don't look at the phone while driving; the button works by feel.
 * Until it is acknowledged the talk button is not shown (children).
 */
export function SafetyGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [ok, setOk] = useState(acknowledged);
  if (ok) return <>{children}</>;
  return (
    <div role="alertdialog" aria-labelledby="talk-safety-title" className="mt-4 w-full space-y-3 rounded-2xl border border-live/50 bg-live/10 p-4">
      <p id="talk-safety-title" className="flex items-center gap-2 text-body font-semibold">
        <TriangleAlert className="h-5 w-5 shrink-0 text-live" /> {t("talk.safetyTitle")}
      </p>
      <p className="text-callout leading-snug">{t("talk.safetyText")}</p>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(KEY, "1");
          } catch {
            /* shown again next time */
          }
          setOk(true);
        }}
        className="h-12 w-full rounded-full bg-primary font-semibold text-primary-foreground"
      >
        {t("talk.safetyOk")}
      </button>
    </div>
  );
}
