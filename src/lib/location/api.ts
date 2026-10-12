import { supabase } from "@/integrations/supabase/client";

/** off = nobody sees you; friends = mutual follows (any distance); everyone = friends + anyone within 200 m. */
export type ShareMode = "off" | "friends" | "everyone";
/** Who may talk to you from the map (push to talk). */
export type TalkFrom = "everyone" | "following" | "nobody";

export interface LocationSharing {
  mode: ShareMode;
  talk_from: TalkFrom;
  has_position: boolean;
  position_at: string | null;
  /** Your own latest position (the map centres on it). */
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
}

/** Someone on your map (friends anywhere, others within the radius of your own position). */
export interface MapPerson {
  user_id: string;
  username: string;
  full_name: string;
  avatar_path: string | null;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  heading: number | null;
  updated_at: string;
  distance_m: number;
  is_friend: boolean;
  can_talk: boolean;
  /** Moved at vehicle speed in the last 5 minutes (drawn as a car while you navigate). */
  in_vehicle?: boolean;
}

export const locationKeys = {
  sharing: ["location", "sharing"] as const,
  people: (radius: number) => ["location", "people", radius] as const,
};

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

export async function mySharing(): Promise<LocationSharing> {
  const { data, error } = await supabase.rpc("my_location_sharing");
  fail(error);
  return ((data ?? [])[0] as LocationSharing | undefined) ?? { mode: "off", talk_from: "everyone", has_position: false, position_at: null, lat: null, lng: null, accuracy_m: null };
}

export async function setSharing(mode: ShareMode, talkFrom?: TalkFrom) {
  fail((await supabase.rpc("set_location_sharing", { p_mode: mode, p_talk_from: talkFrom })).error);
}

export async function sendPosition(p: { lat: number; lng: number; accuracy?: number | null; heading?: number | null; speed?: number | null }) {
  const { error } = await supabase.rpc("update_my_location", {
    p_lat: p.lat,
    p_lng: p.lng,
    p_accuracy: p.accuracy ?? undefined,
    p_heading: p.heading ?? undefined,
    p_speed: p.speed ?? undefined,
  });
  fail(error);
}

export async function mapPeople(radius: number): Promise<MapPerson[]> {
  const { data, error } = await supabase.rpc("map_people", { p_radius_m: radius });
  fail(error);
  return (data ?? []) as MapPerson[];
}
