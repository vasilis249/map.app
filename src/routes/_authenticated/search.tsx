import { createFileRoute, Link } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { UserAvatar } from "@/components/user-avatar";
import { friendKeys, searchUsers } from "@/lib/friends";

export const Route = createFileRoute("/_authenticated/search")({
  component: SearchPage,
});

/** Find people by name (Greek or Latin) or @username. */
function SearchPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const term = useDeferredValue(q.trim().replace(/^@/, ""));
  const results = useQuery({ queryKey: friendKeys.search(term), queryFn: () => searchUsers(term), enabled: term.length >= 2 });
  return (
    <>
      <AppHeader large={t("search.title")} />
      <div className="px-4 pt-2">
        <label className="flex h-12 items-center gap-2 rounded-xl bg-secondary px-3">
          <Search className="h-5 w-5 text-muted-foreground" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("search.placeholder")}
            autoCapitalize="none"
            autoCorrect="off"
            aria-label={t("search.title")}
            className="h-full flex-1 bg-transparent outline-none"
          />
        </label>
        {term.length < 2 ? (
          <p className="py-6 text-center text-caption text-muted-foreground">{t("search.hint")}</p>
        ) : results.data && !results.data.length ? (
          <p className="py-6 text-center text-caption text-muted-foreground">{t("search.empty")}</p>
        ) : (
          <ul className="pt-2">
            {(results.data ?? []).map((p) => (
              <li key={p.id}>
                <Link to="/u/$username" params={{ username: p.username }} className="flex items-center gap-3 py-2.5">
                  <UserAvatar name={p.full_name || p.username} path={p.avatar_path} size={48} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{p.full_name || p.username}</span>
                    <span className="block truncate text-caption text-muted-foreground">
                      @{p.username}
                      {p.i_follow && p.follows_me ? ` · ${t("map.friend")}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
