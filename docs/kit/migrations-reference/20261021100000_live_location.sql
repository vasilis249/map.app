-- Live map, part 1: sharing your location (user request 2026-09-30).
-- Decisions: exact position; friends (mutual follows) see you anywhere, everyone else only within 500 m;
-- anyone within 500 m may talk to you (push to talk, part 3) unless you limit it; location keeps updating with the
-- app closed (native background plugin). Safeguards that go with it:
--   - off by default, you choose: off | friends | everyone (nearby);
--   - reciprocity: to see anyone you must be sharing too, with a fresh position;
--   - the 500 m radius is measured from YOUR stored position, never from a point the client picks (no scanning
--     the city from the sofa);
--   - only the latest position is kept (no history); hidden after 15 min without an update, deleted after 1 h;
--   - blocks hide both people from each other; disabled accounts are hidden.

CREATE TABLE public.location_sharing (
  user_id uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'friends', 'everyone')),
  talk_from text NOT NULL DEFAULT 'everyone' CHECK (talk_from IN ('everyone', 'following', 'nobody')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.location_sharing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.location_sharing FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.location_sharing FROM authenticated;
CREATE POLICY location_sharing_own ON public.location_sharing FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Latest position only. No client access at all: read through map_people, written through update_my_location.
CREATE TABLE private.user_locations (
  user_id uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m real,
  heading real,
  speed real,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_locations_box ON private.user_locations (lat, lng);
ALTER TABLE private.user_locations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.user_locations FROM PUBLIC, anon, authenticated;

-- Great-circle distance in metres.
CREATE FUNCTION private.distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))
$$;

-- Your sharing settings (a row appears the first time you change them).
CREATE FUNCTION public.my_location_sharing()
RETURNS TABLE (mode text, talk_from text, has_position boolean, position_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(s.mode, 'off'), coalesce(s.talk_from, 'everyone'), l.user_id IS NOT NULL, l.updated_at
  FROM (SELECT private.me() AS uid) me
  LEFT JOIN public.location_sharing s ON s.user_id = me.uid
  LEFT JOIN private.user_locations l ON l.user_id = me.uid
$$;

CREATE FUNCTION public.set_location_sharing(p_mode text, p_talk_from text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_mode NOT IN ('off', 'friends', 'everyone') OR (p_talk_from IS NOT NULL AND p_talk_from NOT IN ('everyone', 'following', 'nobody')) THEN
    RAISE EXCEPTION 'bad_setting' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.location_sharing (user_id, mode, talk_from) VALUES (uid, p_mode, coalesce(p_talk_from, 'everyone'))
  ON CONFLICT (user_id) DO UPDATE
    SET mode = EXCLUDED.mode, talk_from = coalesce(p_talk_from, public.location_sharing.talk_from), updated_at = now();
  IF p_mode = 'off' THEN
    DELETE FROM private.user_locations WHERE user_id = uid; -- turning it off forgets where you were
  END IF;
END $$;

-- The app reports where you are (foreground watch or the background plugin). Ignored while sharing is off;
-- at most one write every 3 s.
CREATE FUNCTION public.update_my_location(p_lat double precision, p_lng double precision, p_accuracy real DEFAULT NULL,
                                          p_heading real DEFAULT NULL, p_speed real DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'bad_location' USING ERRCODE = '22023';
  END IF;
  IF coalesce((SELECT mode FROM public.location_sharing WHERE user_id = uid), 'off') = 'off' THEN RETURN false; END IF;
  INSERT INTO private.user_locations AS l (user_id, lat, lng, accuracy_m, heading, speed, updated_at)
  VALUES (uid, p_lat, p_lng, p_accuracy, p_heading, p_speed, now())
  ON CONFLICT (user_id) DO UPDATE
    SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy_m = EXCLUDED.accuracy_m, heading = EXCLUDED.heading,
        speed = EXCLUDED.speed, updated_at = now()
    WHERE l.updated_at < now() - interval '3 seconds';
  RETURN true;
END $$;

-- Who is on your map: friends sharing with friends or everyone (any distance), and people sharing with everyone
-- within p_radius_m (50–500) of your own position. You must be sharing, with a position less than 15 min old.
CREATE FUNCTION public.map_people(p_radius_m int DEFAULT 500)
RETURNS TABLE (user_id uuid, username text, full_name text, avatar_path text, lat double precision,
               lng double precision, accuracy_m real, heading real, updated_at timestamptz, distance_m int,
               is_friend boolean, can_talk boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  me_loc private.user_locations;
  r int := least(greatest(coalesce(p_radius_m, 500), 50), 500);
  dlat double precision;
  dlng double precision;
BEGIN
  IF coalesce((SELECT ls.mode FROM public.location_sharing ls WHERE ls.user_id = uid), 'off') = 'off' THEN RETURN; END IF;
  SELECT * INTO me_loc FROM private.user_locations ul WHERE ul.user_id = uid AND ul.updated_at > now() - interval '15 minutes';
  IF NOT FOUND THEN RETURN; END IF;
  dlat := r / 111320.0;
  dlng := r / (111320.0 * greatest(cos(radians(me_loc.lat)), 0.01));
  RETURN QUERY
  WITH cand AS (
    SELECT l.*, s.mode, s.talk_from, private.are_friends(uid, l.user_id) AS friend
    FROM private.user_locations l
    JOIN public.location_sharing s ON s.user_id = l.user_id AND s.mode <> 'off'
    JOIN public.profiles p ON p.id = l.user_id AND NOT p.disabled
    WHERE l.user_id <> uid AND l.updated_at > now() - interval '15 minutes'
      AND NOT private.is_blocked(uid, l.user_id)
  )
  SELECT c.user_id, p.username, p.full_name, p.avatar_path, c.lat, c.lng, c.accuracy_m, c.heading, c.updated_at,
         round(private.distance_m(me_loc.lat, me_loc.lng, c.lat, c.lng))::int,
         c.friend,
         c.talk_from = 'everyone' OR (c.talk_from = 'following' AND private.follows(c.user_id, uid))
  FROM cand c JOIN public.profiles p ON p.id = c.user_id
  WHERE (c.friend AND c.mode IN ('friends', 'everyone'))
     OR (c.mode = 'everyone'
         AND c.lat BETWEEN me_loc.lat - dlat AND me_loc.lat + dlat
         AND c.lng BETWEEN me_loc.lng - dlng AND me_loc.lng + dlng
         AND private.distance_m(me_loc.lat, me_loc.lng, c.lat, c.lng) <= r)
  ORDER BY 10
  LIMIT 200;
END $$;

-- Are these two people within 500 m of each other right now, both sharing with everyone (or friends sharing)?
-- Used by the nearby push-to-talk channel (part 3).
CREATE FUNCTION private.are_nearby(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM private.user_locations la
    JOIN private.user_locations lb ON lb.user_id = b
    JOIN public.location_sharing sa ON sa.user_id = a
    JOIN public.location_sharing sb ON sb.user_id = b
    WHERE la.user_id = a AND a <> b
      AND la.updated_at > now() - interval '15 minutes' AND lb.updated_at > now() - interval '15 minutes'
      AND sa.mode <> 'off' AND sb.mode <> 'off'
      AND (private.are_friends(a, b) OR (sa.mode = 'everyone' AND sb.mode = 'everyone'))
      AND NOT private.is_blocked(a, b)
      AND private.distance_m(la.lat, la.lng, lb.lat, lb.lng) <= 500)
$$;

-- Old positions go (hidden after 15 min already).
CREATE FUNCTION private.expire_locations()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM private.user_locations WHERE updated_at < now() - interval '1 hour'
$$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('expire-locations', '*/10 * * * *', 'SELECT private.expire_locations()');
  END IF;
END $$;

-- A block also forgets the pair on the map (already filtered; nothing stored per pair).

REVOKE EXECUTE ON FUNCTION private.distance_m(double precision, double precision, double precision, double precision),
  private.are_nearby(uuid, uuid), private.expire_locations() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.my_location_sharing(), public.set_location_sharing(text, text),
  public.update_my_location(double precision, double precision, real, real, real), public.map_people(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_location_sharing(), public.set_location_sharing(text, text),
  public.update_my_location(double precision, double precision, real, real, real), public.map_people(int) TO authenticated;
