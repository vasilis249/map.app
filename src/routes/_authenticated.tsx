import { createFileRoute, Navigate, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { LocationSync } from "@/components/location/location-sync";
import { WalkieBanner, WalkieHubSync } from "@/components/walkie/walkie-hub";
import { useAuth } from "@/hooks/use-auth";
import { onNotificationTap } from "@/lib/local-notify";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

/**
 * Everything behind sign-in: the tab bar, and the app-wide syncs — position sharing + the map inbox (knocks), open
 * walkie channels, the "X is talking to you" banner. Signed out → the sign-in screen.
 */
function AuthenticatedLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    let off: (() => void) | undefined;
    void onNotificationTap((route) => void navigate({ to: route })).then((o) => (off = o));
    return () => off?.();
  }, [navigate]);
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
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
