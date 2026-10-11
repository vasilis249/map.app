import { cn } from "@/lib/utils";

// The "voice" mark: 11 rounded bars, symmetric, the two tall ones at 2/7 and 5/7 (x, half-height).
const BARS: [number, number][] = [
  [2, 0], [4, 1.8], [6, 4], [8, 9], [10, 5.5], [12, 3.6], [14, 5.5], [16, 9], [18, 4], [20, 1.8], [22, 0],
];

/**
 * Used everywhere a voice is recorded (instead of a microphone). `live` makes the bars move — while recording.
 * Drop-in for a lucide icon (`className`, `strokeWidth`).
 */
export function VoiceIcon({ className, strokeWidth = 1.6, live = false }: { className?: string; strokeWidth?: number; live?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      aria-hidden
      className={cn("h-6 w-6 shrink-0", live && "voice-live", className)}
    >
      {BARS.map(([x, h], i) => (
        <line key={x} x1={x} x2={x} y1={12 - h} y2={12 + h} style={live ? { animationDelay: `${(i % 5) * -160}ms` } : undefined} />
      ))}
    </svg>
  );
}
