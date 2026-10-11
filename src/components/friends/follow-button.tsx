import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { friendKeys, profileStats, rpcErrorKey, setFollowing } from "@/lib/friends";
import { cn } from "@/lib/utils";

/** Follow / Following / Follow back for one person (public follow, no approval). Mutual follow = friends. */
export function FollowButton({ userId, className }: { userId: string; className?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const stats = useQuery({ queryKey: friendKeys.stats(userId), queryFn: () => profileStats(userId) });
  const follow = useMutation({
    mutationFn: (on: boolean) => setFollowing(userId, on),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: friendKeys.all });
      void qc.invalidateQueries({ queryKey: ["walkie"] });
      void qc.invalidateQueries({ queryKey: ["location"] }); // friends show on the map at any distance
    },
    onError: (e) => toast.error(t(rpcErrorKey(e))),
  });
  const s = stats.data;
  return (
    <button
      type="button"
      disabled={!s || follow.isPending}
      onClick={() => s && follow.mutate(!s.i_follow)}
      className={cn("h-12 rounded-full font-semibold disabled:opacity-60", s?.i_follow ? "bg-secondary" : "bg-primary text-primary-foreground", className)}
    >
      {!s ? t("profile.follow") : s.i_follow ? t("profile.unfollow") : s.follows_me ? t("profile.followBack") : t("profile.follow")}
    </button>
  );
}
