import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { locationKeys, mySharing } from "@/lib/location/api";
import { onKnock, releaseAllNearby } from "@/lib/location/nearby";
import { startTracking, stopTracking } from "@/lib/location/tracker";
import { walkieHub } from "@/lib/walkie/hub";

/**
 * Root: sends your position while location sharing is on (and stops on sign-out / off), and listens to your map
 * inbox (`nearby-in:<you>`): when someone near you presses to talk, the server knocks here and the conversation
 * opens so you hear them live.
 */
export function LocationSync() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const sharing = useQuery({ queryKey: locationKeys.sharing, queryFn: mySharing, enabled: !!user, staleTime: 60_000 });
  const on = !!user && !!sharing.data && sharing.data.mode !== "off";
  const uid = user?.id;

  useEffect(() => {
    if (on) void startTracking({ title: t("location.bgTitle"), message: t("location.bgMessage") });
    else void stopTracking();
  }, [on, t]);

  useEffect(() => {
    walkieHub.setNearbyArmed(on);
    if (!on || !uid) {
      releaseAllNearby();
      return;
    }
    const ch = supabase
      .channel(`nearby-in:${uid}`, { config: { private: true } })
      .on("broadcast", { event: "knock" }, ({ payload }) => {
        onKnock(payload);
        void qc.invalidateQueries({ queryKey: ["location", "people"] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [on, uid, qc]);

  return null;
}
