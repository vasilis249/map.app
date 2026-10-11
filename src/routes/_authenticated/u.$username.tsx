import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, RadioTower } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { FollowButton } from "@/components/friends/follow-button";
import { FollowCounts } from "@/components/people/follow-counts";
import { PersonActionsSheet } from "@/components/friends/person-actions-sheet";
import { UserAvatar } from "@/components/user-avatar";
import { useAuth } from "@/hooks/use-auth";
import { friendKeys, profileByUsername, profileStats } from "@/lib/friends";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/u/$username")({
  component: ProfilePage,
});

/** Someone's profile: photo, name, @username, bio, counts, Follow, Walkie (friends), ⋯ report / block. */
function ProfilePage() {
  const { username } = Route.useParams();
  const { t } = useTranslation();
  const { user } = useAuth();
  const [actions, setActions] = useState(false);
  const person = useQuery({ queryKey: friendKeys.byUsername(username), queryFn: () => profileByUsername(username) });
  const p = person.data;
  const stats = useQuery({ queryKey: friendKeys.stats(p?.id ?? ""), queryFn: () => profileStats(p!.id), enabled: !!p });
  const s = stats.data;
  const mine = p?.id === user?.id;
  const friends = !!s?.i_follow && !!s?.follows_me;

  return (
    <>
      <AppHeader
        back
        title={p ? `@${p.username}` : ""}
        right={
          p && !mine ? (
            <button type="button" onClick={() => setActions(true)} aria-label={t("friends.actions")} className="grid h-11 w-11 place-items-center rounded-full">
              <MoreHorizontal className="h-5 w-5" />
            </button>
          ) : null
        }
      />
      {person.isSuccess && !p && <p className="px-4 py-10 text-center text-callout text-muted-foreground">{t("profile.notFound")}</p>}
      {p && (
        <div className="flex flex-col items-center px-4 pb-8 pt-4 text-center">
          <span className={cn("rounded-full p-1 ring-4", friends ? "ring-success" : "ring-transparent")}>
            <UserAvatar name={p.full_name || p.username} path={p.avatar_path} size={96} />
          </span>
          <h1 className="mt-3 text-display">{p.full_name || p.username}</h1>
          <p className="text-callout text-muted-foreground">@{p.username}</p>
          {p.bio && <p className="mt-2 max-w-sm whitespace-pre-line text-callout">{p.bio}</p>}
          {s && <FollowCounts userId={p.id} stats={s} className="mt-3" />}
          {friends && <p className="mt-1 text-caption font-semibold text-success">{t("profile.friends")}</p>}
          {s && !mine && (
            <div className="mt-5 grid w-full max-w-sm grid-cols-2 gap-2">
              <FollowButton userId={p.id} />
              {friends ? (
                <Link to="/talk/$userId" params={{ userId: p.id }} className="flex h-12 items-center justify-center gap-2 rounded-full bg-secondary font-semibold">
                  <RadioTower className="h-5 w-5" /> {t("profile.talk")}
                </Link>
              ) : (
                <span className="flex h-12 items-center justify-center rounded-full bg-secondary px-3 text-caption text-muted-foreground">
                  {t("walkie.friendsOnly")}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <PersonActionsSheet person={actions && p ? p : null} onOpenChange={(o) => !o && setActions(false)} />
    </>
  );
}
