import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { APP_SLUG } from "@/lib/brand";
import { haptic } from "@/lib/haptics";
import { setSharing, type LocationSharing, type ShareMode } from "@/lib/location/api";
import { cn } from "@/lib/utils";

const PREV_KEY = `${APP_SLUG}:ghostPrev`;

function remembered(): ShareMode | null {
  try {
    const v = localStorage.getItem(PREV_KEY);
    return v === "friends" || v === "everyone" ? v : null;
  } catch {
    return null;
  }
}
function remember(mode: ShareMode | null) {
  try {
    if (mode) localStorage.setItem(PREV_KEY, mode);
    else localStorage.removeItem(PREV_KEY);
  } catch {
    /* private mode: restore falls back to the settings screen */
  }
}

/**
 * Ghost mode, one tap: sharing off at once (the server deletes your position, you vanish from every map and see
 * nobody). Another tap brings back the mode you had. Shown only when there is something to toggle.
 */
export function GhostButton({ sharing }: { sharing: LocationSharing }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const ghost = sharing.mode === "off";
  const back = remembered();
  const toggle = useMutation({
    mutationFn: async () => {
      if (!ghost) {
        remember(sharing.mode);
        await setSharing("off");
      } else if (back) {
        await setSharing(back);
        remember(null);
      }
    },
    onMutate: () => haptic("medium"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["location"] });
      if (!ghost) toast(t("map.ghostOn"));
    },
    onError: () => toast.error(t("errors.generic")),
  });
  if (ghost && !back) return null;
  return (
    <button
      type="button"
      disabled={toggle.isPending}
      onClick={() => toggle.mutate()}
      aria-pressed={ghost}
      aria-label={ghost ? t("map.ghostOff") : t("map.ghost")}
      className={cn(
        "pointer-events-auto flex h-12 items-center gap-2 rounded-full border border-border/60 px-4 text-caption font-semibold shadow-float",
        ghost ? "bg-primary text-primary-foreground" : "glass",
      )}
    >
      {ghost ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
      {ghost ? t("map.ghostOff") : t("map.ghost")}
    </button>
  );
}
