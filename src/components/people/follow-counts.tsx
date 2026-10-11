import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ProfileStats } from "@/lib/friends";

/** "12 Followers · 30 Following", each opening its list. */
export function FollowCounts({ userId, stats, className }: { userId: string; stats: ProfileStats; className?: string }) {
  const { t } = useTranslation();
  return (
    <p className={className}>
      <Link to="/people/$userId/$list" params={{ userId, list: "followers" }} className="text-caption text-muted-foreground">
        <b className="text-foreground">{stats.followers}</b> {t("profile.followers")}
      </Link>
      <span className="text-caption text-muted-foreground"> · </span>
      <Link to="/people/$userId/$list" params={{ userId, list: "following" }} className="text-caption text-muted-foreground">
        <b className="text-foreground">{stats.following}</b> {t("profile.following")}
      </Link>
    </p>
  );
}
