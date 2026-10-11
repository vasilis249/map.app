import type { ComponentType, ReactNode } from "react";

/** Empty screen: optional icon, a bold line, one short sentence, optional action. */
export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  title?: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 py-24 text-center animate-fade-in-up">
      {Icon && <Icon className="mb-2 h-10 w-10 text-muted-foreground" strokeWidth={1.5} />}
      {title && <h2 className="text-tagline font-semibold">{title}</h2>}
      <p className="text-body text-muted-foreground">{text}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
