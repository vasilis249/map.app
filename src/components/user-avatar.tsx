import { avatarUrl } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/** Round avatar: the photo if there is one, otherwise the first letter on grey. */
export function UserAvatar({
  name,
  path,
  size = 48,
  className,
}: {
  name: string;
  path?: string | null;
  size?: number;
  className?: string;
}) {
  const url = avatarUrl(path);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (url) {
    return <img src={url} alt="" style={style} className={cn("shrink-0 rounded-full object-cover", className)} />;
  }
  return (
    <span
      style={style}
      className={cn("grid shrink-0 place-items-center rounded-full bg-secondary font-semibold uppercase", className)}
    >
      {(name.trim() || "?").charAt(0)}
    </span>
  );
}
