import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** iOS segmented control (DESIGN.md): grey pill track, the selected segment a raised white (dark: grey) pill. */
export function Segmented<T extends string | boolean>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("flex rounded-full bg-secondary p-0.5", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-8 min-w-0 flex-auto truncate rounded-full px-2.5 text-caption font-semibold tracking-[-0.3px] transition-colors",
              on ? "bg-segment text-foreground" : "text-muted-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
