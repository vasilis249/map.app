import { createFileRoute, notFound } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { PersonRow, RowFollow } from "@/components/people/person-row";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { followList, friendKeys, LIST_PAGE, removeFollower, rpcErrorKey, type Person } from "@/lib/friends";

export const Route = createFileRoute("/_authenticated/people/$userId/$list")({
  beforeLoad: ({ params }) => {
    if (params.list !== "followers" && params.list !== "following") throw notFound();
  },
  component: FollowListPage,
});

/** Someone's followers or following, paged (newest first). On your own followers: remove one. */
function FollowListPage() {
  const { userId, list } = Route.useParams();
  const which = list as "followers" | "following";
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const owner = useQuery({
    queryKey: ["profile", userId],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id, username, full_name").eq("id", userId).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const people = useInfiniteQuery({
    queryKey: friendKeys.list(userId, which),
    queryFn: ({ pageParam }) => followList(userId, which, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length < LIST_PAGE ? undefined : pages.length * LIST_PAGE),
  });
  const remove = useMutation({
    mutationFn: (p: Person) => removeFollower(p.id),
    onSuccess: () => {
      toast(t("people.removed"));
      void qc.invalidateQueries({ queryKey: friendKeys.all });
    },
    onError: (e) => toast.error(t(rpcErrorKey(e))),
  });
  const mine = userId === user?.id;
  const rows = people.data?.pages.flat() ?? [];
  const name = owner.data ? owner.data.full_name || owner.data.username : "";
  return (
    <>
      <AppHeader back title={`${t(which === "followers" ? "profile.followers" : "profile.following")}${name ? ` · ${name}` : ""}`} />
      <div className="px-4">
        {people.isSuccess && !rows.length && <p className="py-10 text-center text-callout text-muted-foreground">{t(`people.empty.${which}`)}</p>}
        <ul>
          {rows.map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              right={
                p.id === user?.id ? null : mine && which === "followers" ? (
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(p)}
                    className="h-9 shrink-0 rounded-full bg-secondary px-4 text-caption font-semibold disabled:opacity-60"
                  >
                    {t("people.remove")}
                  </button>
                ) : (
                  <RowFollow person={p} />
                )
              }
            />
          ))}
        </ul>
        {people.hasNextPage && (
          <button
            type="button"
            disabled={people.isFetchingNextPage}
            onClick={() => void people.fetchNextPage()}
            className="my-4 h-11 w-full rounded-full bg-secondary font-semibold disabled:opacity-60"
          >
            {t("people.more")}
          </button>
        )}
      </div>
    </>
  );
}
