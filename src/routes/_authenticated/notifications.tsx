import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AppHeader } from "@/components/app-header";
import { UserAvatar } from "@/components/user-avatar";
import { listNotifications, markAllRead, notificationKeys, type AppNotification } from "@/lib/notifications";
import { timeAgoShort } from "@/lib/time-ago";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/notifications")({
  component: NotificationsPage,
});

/** Follows, map talk, missed walkie transmissions. Opening the screen marks them read. */
function NotificationsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: notificationKeys.list, queryFn: listNotifications });
  const hasUnread = !!list.data?.some((n) => !n.read_at);
  useEffect(() => {
    if (!hasUnread) return;
    void markAllRead().then(() => qc.invalidateQueries({ queryKey: notificationKeys.unread }));
  }, [hasUnread, qc]);

  return (
    <>
      <AppHeader large={t("notifications.title")} />
      {list.data && !list.data.length && <p className="px-4 py-10 text-center text-callout text-muted-foreground">{t("notifications.empty")}</p>}
      <ul className="px-4">
        {(list.data ?? []).map((n) => (
          <li key={n.id}>
            <Row n={n} text={t(`notifications.${n.kind}`, { name: n.actor ? n.actor.full_name || n.actor.username : "" })} when={timeAgoShort(n.created_at, i18n.language)} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Row({ n, text, when }: { n: AppNotification; text: string; when: string }) {
  const body = (
    <span className={cn("flex items-center gap-3 py-2.5", !n.read_at && "font-semibold")}>
      <UserAvatar name={n.actor?.full_name || n.actor?.username || "?"} path={n.actor?.avatar_path ?? null} size={44} />
      <span className="min-w-0 flex-1 text-callout">{text}</span>
      <span className="text-caption text-muted-foreground">{when}</span>
    </span>
  );
  if (!n.actor) return body;
  if (n.kind === "walkie") return <Link to="/talk/$userId" params={{ userId: n.actor.id }}>{body}</Link>;
  if (n.kind === "nearby") return <Link to="/map" search={{ u: n.actor.id }}>{body}</Link>;
  return <Link to="/u/$username" params={{ username: n.actor.username }}>{body}</Link>;
}
