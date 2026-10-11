import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { UserAvatar } from "@/components/user-avatar";
import { friendKeys, rpcErrorKey, setFollowing, type Person } from "@/lib/friends";
import { cn } from "@/lib/utils";

/** A person in a list (search, followers, suggestions): photo, name, @username → their profile; an action on the right. */
export function PersonRow({ person, right, sub }: { person: Person; right?: ReactNode; sub?: ReactNode }) {
  const { t } = useTranslation();
  const friends = person.i_follow && person.follows_me;
  return (
    <li className="flex items-center gap-3 py-2">
      <Link to="/u/$username" params={{ username: person.username }} className="flex min-w-0 flex-1 items-center gap-3">
        <span className={cn("rounded-full p-0.5 ring-2", friends ? "ring-success" : "ring-transparent")}>
          <UserAvatar name={person.full_name || person.username} path={person.avatar_path} size={46} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{person.full_name || person.username}</span>
          <span className="block truncate text-caption text-muted-foreground">
            {sub ?? <>@{person.username}{friends ? ` · ${t("map.friend")}` : person.follows_me ? ` · ${t("people.followsYou")}` : ""}</>}
          </span>
        </span>
      </Link>
      {right}
    </li>
  );
}

/** Small Follow / Following toggle for a row (the row's own i_follow; lists refresh after). */
export function RowFollow({ person }: { person: Person }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => setFollowing(person.id, !person.i_follow),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: friendKeys.all });
      void qc.invalidateQueries({ queryKey: ["walkie"] });
      void qc.invalidateQueries({ queryKey: ["location"] });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e) => toast.error(t(rpcErrorKey(e))),
  });
  return (
    <button
      type="button"
      disabled={m.isPending}
      onClick={() => m.mutate()}
      className={cn("h-9 shrink-0 rounded-full px-4 text-caption font-semibold disabled:opacity-60", person.i_follow ? "bg-secondary" : "bg-primary text-primary-foreground")}
    >
      {person.i_follow ? t("profile.unfollow") : person.follows_me ? t("profile.followBack") : t("profile.follow")}
    </button>
  );
}
