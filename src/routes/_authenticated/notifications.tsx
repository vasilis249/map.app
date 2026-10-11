import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AppHeader } from "@/components/app-header";
import { RowFollow } from "@/components/people/person-row";
import { UserAvatar } from "@/components/user-avatar";
import { useAuth } from "@/hooks/use-auth";
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
  const { user } = useAuth();
  const list = useQuery({ queryKey: notificationKeys.list, queryFn: () => listNotifications(user!.id), enabled: !!user });
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
    <span className={cn("flex min-w-0 flex-1 items-center gap-3 py-2.5", !n.read_at && "font-semibold")}>
      <UserAvatar name={n.actor?.full_name || n.actor?.username || "?"} path={n.actor?.avatar_path ?? null} size={44} />
      <span className="min-w-0 flex-1 text-callout">
        {text} <span className="font-normal text-muted-foreground">· {when}</span>
      </span>
    </span>
  );
  if (!n.actor) return body;
  const a = n.actor;
  const link =
    n.kind === "walkie" ? (
      <Link to="/talk/$userId" params={{ userId: a.id }} className="min-w-0 flex-1">{body}</Link>
    ) : n.kind === "nearby" ? (
      <Link to="/map" search={{ u: a.id }} className="min-w-0 flex-1">{body}</Link>
    ) : (
      <Link to="/u/$username" params={{ username: a.username }} className="min-w-0 flex-1">{body}</Link>
    );
  return (
    <span className="flex items-center gap-2">
      {link}
      {n.kind === "follow" && <RowFollow person={{ ...a, i_follow: n.i_follow, follows_me: true }} />}
    </span>
  );
}
