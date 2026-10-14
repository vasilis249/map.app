import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { UserAvatar } from "@/components/user-avatar";
import { VehicleForm } from "@/components/spot/spot-ui";
import { deleteMyVehicle, leaderboard, myVehicle, setMyVehicle, SpotApiError, spotKeys, useSpotState } from "@/lib/spot/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/exchange")({
  component: ExchangePage,
});

/** Spot exchange (P8): my vehicle (plate for the other driver), my credits / points / reliability, how it works, the week's leaderboard. */
function ExchangePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const vehicle = useQuery({ queryKey: spotKeys.vehicle, queryFn: myVehicle });
  const state = useSpotState();
  const board = useQuery({ queryKey: spotKeys.leaderboard, queryFn: leaderboard });
  const err = (e: unknown) => toast.error(t(e instanceof SpotApiError && e.code !== "generic" ? `spot.errors.${e.code}` : "errors.generic"));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: spotKeys.vehicle });
    void qc.invalidateQueries({ queryKey: spotKeys.state });
  };
  const save = useMutation({ mutationFn: setMyVehicle, onSuccess: () => (toast(t("spot.saved")), refresh()), onError: err });
  const remove = useMutation({ mutationFn: deleteMyVehicle, onSuccess: refresh, onError: err });
  const w = state.data?.wallet;
  const how = t("spot.how", { returnObjects: true }) as unknown as string[];
  return (
    <>
      <AppHeader back title={t("spot.title")} />
      <div className="space-y-6 px-4 pb-32">
        {w && (
          <section className="rounded-3xl glass p-4" data-testid="wallet">
            <h2 className="text-callout font-semibold text-muted-foreground">{t("spot.wallet")}</h2>
            <p className="mt-1 text-hero font-bold tabular-nums">{t("spot.credits", { count: w.credits })}</p>
            <p className="text-caption text-muted-foreground">
              {[t("spot.points", { count: w.points }), t("spot.exchanges", { count: w.exchanges }), t("spot.reliability", { pct: w.reliability })].join(" · ")}
            </p>
            {w.blocked && <p className="mt-2 text-caption font-semibold text-destructive">{t("spot.blocked")}</p>}
          </section>
        )}
        <section>
          <h2 className="mb-3 text-callout font-semibold text-muted-foreground">{t("spot.vehicle")}</h2>
          {vehicle.isSuccess && <VehicleForm value={vehicle.data} busy={save.isPending} onSave={(v) => save.mutate(v)} onRemove={() => remove.mutate()} />}
        </section>
        <section>
          <h2 className="mb-2 text-callout font-semibold text-muted-foreground">{t("spot.howTitle")}</h2>
          <ol className="list-decimal space-y-1.5 pl-5 text-callout">
            {how.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ol>
        </section>
        <section>
          <h2 className="mb-2 text-callout font-semibold text-muted-foreground">{t("spot.leaderboard")}</h2>
          {board.data && !board.data.length && <p className="text-caption text-muted-foreground">{t("spot.noLeaders")}</p>}
          <ol aria-label={t("spot.leaderboard")}>
            {(board.data ?? []).map((r) => (
              <li key={r.user_id} className={cn("flex items-center gap-3 rounded-2xl px-2 py-2", r.me && "glass-tile")}>
                <span className="w-6 text-center font-bold tabular-nums">{r.rank}</span>
                <UserAvatar name={r.full_name || r.username} path={r.avatar_path} size={36} />
                <span className="min-w-0 flex-1 truncate font-semibold">{r.full_name || r.username}</span>
                <span className="text-caption font-semibold tabular-nums">{t("spot.points", { count: r.points })}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
