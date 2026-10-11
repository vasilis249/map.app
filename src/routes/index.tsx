import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/")({
  component: Index,
});

/** Home: the map when signed in, else the sign-in screen. */
function Index() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={user ? "/map" : "/login"} replace />;
}
