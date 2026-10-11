import { createFileRoute, Navigate, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AgeGate } from "@/components/age-gate";
import { BottomNav } from "@/components/bottom-nav";
import { LocationSync } from "@/components/location/location-sync";
import { WalkieBanner, WalkieHubSync } from "@/components/walkie/walkie-hub";
import { useAuth } from "@/hooks/use-auth";
import { useMyProfile } from "@/hooks/use-my-profile";
import { signOut } from "@/lib/sign-out";
import { onNotificationTap } from "@/lib/local-notify";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

/**
 * Everything behind sign-in: the tab bar, and the app-wide syncs — position sharing + the map inbox (knocks), open
 * walkie channels, the "X is talking to you" banner. Signed out → the sign-in screen; no 18+ declaration yet → the
 * age gate (the server refuses everything until then).
 */
function AuthenticatedLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { t } = useTranslation();
  const profile = useMyProfile();
  useEffect(() => {
    let off: (() => void) | undefined;
    void onNotificationTap((route) => void navigate({ to: route })).then((o) => (off = o));
    return () => off?.();
  }, [navigate]);
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!profile.data)
    return profile.isError ? (
      <main className="grid min-h-dvh place-items-center px-6 text-center">
        <div className="space-y-3">
          <p className="text-callout text-muted-foreground">{t("errors.generic")}</p>
          <button type="button" onClick={() => void profile.refetch()} className="h-11 rounded-full bg-primary px-6 font-semibold text-primary-foreground">
            {t("map.retry")}
          </button>
        </div>
      </main>
    ) : null;
  if (!profile.data.age_confirmed_at)
    return <AgeGate onSignOut={() => void signOut(qc).then(() => navigate({ to: "/login", replace: true }))} />;
  return (
    <div className="flex min-h-dvh flex-col pb-[calc(env(safe-area-inset-bottom)+6rem)]">
      <LocationSync />
      <WalkieHubSync />
      <WalkieBanner />
      <Outlet />
      <BottomNav />
    </div>
  );
}
