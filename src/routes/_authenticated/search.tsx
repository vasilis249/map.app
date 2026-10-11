import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PersonRow, RowFollow } from "@/components/people/person-row";
import { friendKeys, searchUsers, suggestedPeople } from "@/lib/friends";

export const Route = createFileRoute("/_authenticated/search")({
  component: SearchPage,
});

/** Find people by name (Greek or Latin) or @username; people to follow while the box is empty. */
function SearchPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const term = useDeferredValue(q.trim().replace(/^@/, ""));
  const results = useQuery({ queryKey: friendKeys.search(term), queryFn: () => searchUsers(term), enabled: term.length >= 2 });
  const suggested = useQuery({ queryKey: friendKeys.suggested, queryFn: () => suggestedPeople(15), enabled: term.length === 0 });
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
        {term.length === 0 ? (
          (suggested.data?.length ?? 0) > 0 && (
            <section className="pt-4">
              <h2 className="pb-1 text-callout font-semibold text-muted-foreground">{t("search.suggested")}</h2>
              <ul>
                {suggested.data!.map((p) => (
                  <PersonRow key={p.id} person={p} right={<RowFollow person={p} />} />
                ))}
              </ul>
            </section>
          )
        ) : term.length < 2 ? (
          <p className="py-6 text-center text-caption text-muted-foreground">{t("search.hint")}</p>
        ) : results.data && !results.data.length ? (
          <p className="py-6 text-center text-caption text-muted-foreground">{t("search.empty")}</p>
        ) : (
          <ul className="pt-2">
            {(results.data ?? []).map((p) => (
              <PersonRow key={p.id} person={p} right={<RowFollow person={p} />} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
