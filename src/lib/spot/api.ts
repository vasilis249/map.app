import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { LatLng } from "@/lib/nav/geo";
import { boxAround } from "@/lib/reports/api";
import type { Colour } from "./plate";

/**
 * Parking spot exchange (P8, the SpotSmiley logic): offer your spot as you leave, claim one with a credit, meet your
 * "spot mate". The server (spot_* RPCs) decides everything; this is the client side.
 */

export type SpotMsg = "on_my_way" | "here" | "late" | "waiting" | "leaving_now" | "look_for_me" | "thanks";
/** What each side can send (one tap; no typing while driving). */
export const GIVER_MSGS: SpotMsg[] = ["waiting", "leaving_now", "look_for_me", "thanks"];
export const TAKER_MSGS: SpotMsg[] = ["on_my_way", "late", "here", "thanks"];

export interface Vehicle {
  plate: string;
  make: string | null;
  colour: Colour;
}

export interface Wallet {
  credits: number;
  points: number;
  exchanges: number;
  reliability: number;
  blocked: boolean;
  vehicle: boolean;
}

export interface SpotMatch {
  id: string;
  role: "giver" | "taker";
  state: "active" | "done" | "cancelled" | "no_show" | "expired";
  created_at: string;
  ended_at: string | null;
  ended_by_me: boolean | null;
  arrived_at: string | null;
  eta_s: number | null;
  mate: {
    user_id: string;
    username: string;
    full_name: string;
    avatar_path: string | null;
    plate: string | null;
    make: string | null;
    colour: Colour | null;
  };
  mate_pos: (LatLng & { at: string }) | null;
  mate_msg: SpotMsg | null;
  mate_msg_at: string | null;
  my_msg: SpotMsg | null;
}

export interface SpotState {
  wallet: Wallet;
  offer?: LatLng & { id: string; leave_at: string; state: "open" | "matched" | "done" | "cancelled" | "expired" };
  match?: SpotMatch;
}

export interface SpotOffer extends LatLng {
  id: string;
  leave_at: string;
  created_at: string;
}

export type SpotError =
  | "no_vehicle"
  | "spot_blocked"
  | "no_credits"
  | "taken"
  | "too_far"
  | "already_active"
  | "own_offer"
  | "too_early"
  | "no_match"
  | "bad_plate"
  | "rate_limited";
const KNOWN: SpotError[] = ["no_vehicle", "spot_blocked", "no_credits", "taken", "too_far", "already_active", "own_offer", "too_early", "no_match", "bad_plate", "rate_limited"];

export class SpotApiError extends Error {
  constructor(public code: SpotError | "generic") {
    super(code);
  }
}
function fail(error: { message: string } | null) {
  if (!error) return;
  throw new SpotApiError(KNOWN.find((k) => error.message === k) ?? "generic");
}

export const spotKeys = {
  state: ["spot", "state"] as const,
  vehicle: ["spot", "vehicle"] as const,
  offers: (k: string) => ["spot", "offers", k] as const,
  leaderboard: ["spot", "leaderboard"] as const,
};

export async function myVehicle(): Promise<Vehicle | null> {
  const { data, error } = await supabase.rpc("my_vehicle");
  fail(error);
  return ((data ?? []) as Vehicle[])[0] ?? null;
}
export async function setMyVehicle(v: { plate: string; make: string; colour: Colour }) {
  fail((await supabase.rpc("set_my_vehicle", { p_plate: v.plate, p_make: v.make, p_colour: v.colour })).error);
}
export async function deleteMyVehicle() {
  fail((await supabase.rpc("delete_my_vehicle")).error);
}

export async function spotState(): Promise<SpotState> {
  const { data, error } = await supabase.rpc("spot_state");
  fail(error);
  return data as unknown as SpotState;
}

/** My exchange, polled: every 2 s while one runs, 3 s while my offer waits, else 20 s. */
export function useSpotState(enabled = true) {
  return useQuery({
    queryKey: spotKeys.state,
    queryFn: spotState,
    enabled,
    refetchInterval: (q) => {
      const s = q.state.data;
      if (s?.match?.state === "active") return 2_000;
      if (s?.offer?.state === "open") return 3_000;
      return 20_000;
    },
  });
}

export async function offerSpot(at: LatLng, inMin: 0 | 2 | 5 | 10): Promise<string> {
  const { data, error } = await supabase.rpc("spot_offer", { p_lat: at.lat, p_lng: at.lng, p_in_min: inMin });
  fail(error);
  return data as string;
}

/** Open offers around you (≈ 1.5 km), every 5 s (they come and go fast). */
export function useSpotOffers(me: LatLng | null, enabled: boolean) {
  const key = me ? `${me.lat.toFixed(2)},${me.lng.toFixed(2)}` : "-";
  const box = useMemo(() => {
    if (key === "-") return null;
    const [lat, lng] = key.split(",").map(Number);
    return boxAround([{ lat, lng }], 0.015);
  }, [key]);
  return useQuery({
    queryKey: spotKeys.offers(key),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("spot_offers_in", { p_min_lat: box!.minLat, p_min_lng: box!.minLng, p_max_lat: box!.maxLat, p_max_lng: box!.maxLng });
      fail(error);
      return (data ?? []) as SpotOffer[];
    },
    enabled: enabled && !!box,
    refetchInterval: 5_000,
  });
}

export async function claimSpot(id: string, me: LatLng): Promise<string> {
  const { data, error } = await supabase.rpc("spot_claim", { p_offer: id, p_lat: me.lat, p_lng: me.lng });
  fail(error);
  return data as string;
}

export async function spotUpdate(me: LatLng, etaS: number | null) {
  const { error } = await supabase.rpc("spot_update", { p_lat: me.lat, p_lng: me.lng, p_eta_s: etaS == null ? undefined : Math.round(etaS) });
  if (error && error.message !== "no_match") fail(error);
}

export async function spotMessage(m: SpotMsg) {
  fail((await supabase.rpc("spot_message", { p_msg: m })).error);
}
export async function spotDone() {
  fail((await supabase.rpc("spot_done")).error);
}
/** Cancel my offer / exchange — or, with noShow, say the other didn't turn up. */
export async function spotCancel(noShow = false) {
  fail((await supabase.rpc("spot_cancel", { p_no_show: noShow })).error);
}

export interface LeaderRow {
  rank: number;
  user_id: string;
  username: string;
  full_name: string;
  avatar_path: string | null;
  points: number;
  me: boolean;
}
export async function leaderboard(): Promise<LeaderRow[]> {
  const { data, error } = await supabase.rpc("spot_leaderboard");
  fail(error);
  return (data ?? []) as LeaderRow[];
}
