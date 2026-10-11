import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { base64ToBlob, formatClock, player } from "@/lib/audio";
import { timeAgoShort } from "@/lib/time-ago";
import type { WalkieItem } from "@/lib/walkie/history";
import { cn } from "@/lib/utils";

/** One saved transmission (24 h): play / pause, who, length, when. */
export function HistoryRow({
  item,
  mine,
  name,
  locale,
  load,
}: {
  item: WalkieItem;
  mine: boolean;
  name: string;
  locale: string;
  load: (id: string) => Promise<{ mime: string; audio_b64: string }>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  async function toggle() {
    if (state !== "idle") {
      player.stop();
      setState("idle");
      return;
    }
    player.prime(); // inside the tap (iOS)
    setState("loading");
    try {
      const a = await load(item.id);
      setState("playing");
      await player.play(base64ToBlob(a.audio_b64, a.mime), { durationMs: item.duration_ms, onEnd: () => setState("idle") });
    } catch {
      setState("idle");
      toast.error(t("voice.playFailed"));
    }
  }
  return (
    <li className="flex items-center gap-3 py-2.5">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-label={state === "playing" ? t("walkie.pause") : t("walkie.play")}
        className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-full", mine ? "bg-secondary" : "bg-primary text-primary-foreground")}
      >
        {state === "playing" ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
      </button>
      <span className="flex-1 text-callout font-normal">{mine ? t("walkie.you") : name}</span>
      <span className="text-caption tabular-nums text-muted-foreground">
        {formatClock(item.duration_ms)} · {timeAgoShort(item.created_at, locale)}
      </span>
    </li>
  );
}
