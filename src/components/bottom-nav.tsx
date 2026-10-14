import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Bell, Map as MapIcon, RadioTower, Search, User } from "lucide-react";
import { useWalkieList } from "@/components/walkie/walkie-hub";
import { notificationKeys, unreadCount } from "@/lib/notifications";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/map", icon: MapIcon, label: "tabs.map" },
  { to: "/talk", icon: RadioTower, label: "tabs.talk" },
  { to: "/search", icon: Search, label: "tabs.search" },
  { to: "/notifications", icon: Bell, label: "tabs.notifications" },
  { to: "/profile", icon: User, label: "tabs.profile" },
] as const;

/**
 * Floating tab bar, iOS 26 style: a Liquid Glass capsule above the home indicator; the current tab sits in a glass
 * "droplet", tinted. Big targets: 56 px tall, icon + short label.
 */
export function BottomNav() {
  const { t } = useTranslation();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const unread = useQuery({ queryKey: notificationKeys.unread, queryFn: unreadCount, refetchInterval: 60_000 });
  // Friends' walkie transmissions you haven't heard yet (24 h).
  const walkie = useWalkieList();
  const unheard = (walkie.data ?? []).reduce((n, c) => n + c.unheard, 0);
  return (
    <nav
      aria-label="tabs"
      className="glass fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-40 mx-auto flex w-[min(28rem,calc(100%-2rem))] items-center justify-around rounded-full p-1"
    >
      {TABS.map(({ to, icon: Icon, label }) => {
        const active = path === to || path.startsWith(`${to}/`);
        const badge = to === "/notifications" ? (unread.data ?? 0) : to === "/talk" ? unheard : 0;
        return (
          <Link
            key={to}
            to={to}
            aria-label={badge ? `${t(label)} (${badge})` : t(label)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-full transition-colors",
              active ? "glass-pill text-link" : "text-foreground/75",
            )}
          >
            <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.3 : 1.9} />
            <span aria-hidden className="text-[10px] font-semibold leading-none tracking-tight">
              {t(label)}
            </span>
            {badge > 0 && (
              <span className="absolute right-[calc(50%-1.35rem)] top-1 min-w-[18px] rounded-full border-2 border-background bg-live px-1 text-center text-[10px] font-semibold leading-[14px] text-destructive-foreground tabular-nums">
                {badge > 9 ? "9+" : badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
