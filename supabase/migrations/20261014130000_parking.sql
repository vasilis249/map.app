-- P7: parking spots (owner's request). Someone leaving a spot marks it free (green, 15 min); someone parking marks the
-- spot taken (red, 10 min) — on a green spot nearby it turns that one red for everyone. Anyone can say a green one got
-- taken. Anonymous (no author returned), hidden between blocked people and for disabled accounts. Privacy: a spot is
-- who + where + when, so rows are deleted an hour after they expire (cron expire-parking); "where my car is" stays on
-- the phone only. Limits: 20 marks / 10 min + 60 / day, 30 "taken" / 10 min; boxes ≤ 0.5°.

CREATE TABLE private.parking_spots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state text NOT NULL CHECK (state IN ('free', 'taken')),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  created_by uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- when it last changed (free → taken)
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX parking_spots_box ON private.parking_spots (lat, lng);
ALTER TABLE private.parking_spots ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION private.parking_ttl(p_state text)
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_state WHEN 'free' THEN interval '15 minutes' WHEN 'taken' THEN interval '10 minutes' END
$$;

CREATE FUNCTION private.parking_args_ok(p_lat double precision, p_lng double precision)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_lat IS NOT NULL AND p_lng IS NOT NULL AND p_lat BETWEEN -90 AND 90 AND p_lng BETWEEN -180 AND 180
$$;

-- An active spot near a point that you may see (not between blocked people), nearest first.
CREATE FUNCTION private.parking_near(p_uid uuid, p_state text, p_lat double precision, p_lng double precision, p_m double precision)
RETURNS private.parking_spots LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.* FROM private.parking_spots s
  WHERE s.state = p_state AND s.expires_at > now()
    AND s.lat BETWEEN p_lat - 0.001 AND p_lat + 0.001 AND s.lng BETWEEN p_lng - 0.0015 AND p_lng + 0.0015
    AND private.distance_m(s.lat, s.lng, p_lat, p_lng) <= p_m
    AND NOT private.is_blocked(p_uid, s.created_by)
  ORDER BY private.distance_m(s.lat, s.lng, p_lat, p_lng) LIMIT 1
$$;

-- I'm leaving this spot: it's free (green). Your own green spot within 30 m is refreshed instead of a second one; your
-- own red spot there (you parked here earlier) goes. Returns the spot's id. Errors: bad_input, rate_limited.
CREATE FUNCTION public.parking_leave(p_lat double precision, p_lng double precision)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  mine private.parking_spots;
  sid uuid;
BEGIN
  IF NOT private.parking_args_ok(p_lat, p_lng) THEN RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023'; END IF;
  PERFORM private.rate_limit('parking', 20, interval '10 minutes');
  PERFORM private.rate_limit('parking_day', 60, interval '1 day');
  DELETE FROM private.parking_spots s
  WHERE s.created_by = uid AND s.state = 'taken' AND private.distance_m(s.lat, s.lng, p_lat, p_lng) <= 30;
  SELECT * INTO mine FROM private.parking_near(uid, 'free', p_lat, p_lng, 30) s WHERE s.created_by = uid;
  IF mine.id IS NOT NULL THEN
    UPDATE private.parking_spots SET lat = p_lat, lng = p_lng, updated_at = now(), expires_at = now() + private.parking_ttl('free')
    WHERE id = mine.id;
    RETURN mine.id;
  END IF;
  INSERT INTO private.parking_spots (state, lat, lng, created_by, expires_at)
  VALUES ('free', p_lat, p_lng, uid, now() + private.parking_ttl('free'))
  RETURNING id INTO sid;
  RETURN sid;
END $$;

-- I parked here: a green spot within 15 m (someone else's) turns red for everyone; otherwise a red spot here.
-- Returns the spot's id. Errors: bad_input, rate_limited.
CREATE FUNCTION public.parking_park(p_lat double precision, p_lng double precision)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  green private.parking_spots;
  sid uuid;
BEGIN
  IF NOT private.parking_args_ok(p_lat, p_lng) THEN RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023'; END IF;
  PERFORM private.rate_limit('parking', 20, interval '10 minutes');
  PERFORM private.rate_limit('parking_day', 60, interval '1 day');
  -- your own green spot here: you came back to it
  DELETE FROM private.parking_spots s
  WHERE s.created_by = uid AND s.state = 'free' AND private.distance_m(s.lat, s.lng, p_lat, p_lng) <= 15;
  green := private.parking_near(uid, 'free', p_lat, p_lng, 15);
  IF green.id IS NOT NULL THEN
    UPDATE private.parking_spots SET state = 'taken', updated_at = now(), expires_at = now() + private.parking_ttl('taken')
    WHERE id = green.id;
    RETURN green.id;
  END IF;
  INSERT INTO private.parking_spots (state, lat, lng, created_by, expires_at)
  VALUES ('taken', p_lat, p_lng, uid, now() + private.parking_ttl('taken'))
  RETURNING id INTO sid;
  RETURN sid;
END $$;

-- A green spot I can see got taken (someone parked there without the app). Errors: not_found, rate_limited.
CREATE FUNCTION public.parking_taken(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  PERFORM private.rate_limit('parking_taken', 30, interval '10 minutes');
  UPDATE private.parking_spots s SET state = 'taken', updated_at = now(), expires_at = now() + private.parking_ttl('taken')
  WHERE s.id = p_id AND s.state = 'free' AND s.expires_at > now() AND NOT private.is_blocked(uid, s.created_by);
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
END $$;

-- Active spots in a box (around you, or around your destination). Who marked them is never returned.
CREATE FUNCTION public.parking_in(p_min_lat double precision, p_min_lng double precision,
                                  p_max_lat double precision, p_max_lng double precision)
RETURNS TABLE (id uuid, state text, lat double precision, lng double precision, updated_at timestamptz,
               expires_at timestamptz, mine boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_min_lat IS NULL OR p_max_lat IS NULL OR p_min_lng IS NULL OR p_max_lng IS NULL
     OR p_max_lat < p_min_lat OR p_max_lng < p_min_lng OR p_max_lat - p_min_lat > 0.5 OR p_max_lng - p_min_lng > 0.5 THEN
    RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT s.id, s.state, s.lat, s.lng, s.updated_at, s.expires_at, s.created_by = uid
  FROM private.parking_spots s
  JOIN public.profiles p ON p.id = s.created_by AND NOT p.disabled
  WHERE s.expires_at > now()
    AND s.lat BETWEEN p_min_lat AND p_max_lat AND s.lng BETWEEN p_min_lng AND p_max_lng
    AND NOT private.is_blocked(uid, s.created_by)
  ORDER BY abs(s.lat - (p_min_lat + p_max_lat) / 2) + abs(s.lng - (p_min_lng + p_max_lng) / 2)
  LIMIT 200;
END $$;

-- Expired an hour ago: deleted.
CREATE FUNCTION private.expire_parking()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM private.parking_spots WHERE expires_at < now() - interval '1 hour';
$$;

-- Privileges (as the baseline's section 12).
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA private TO service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_blocked(uuid, uuid), private.walkie_topic_ok(text), private.nearby_topic_ok(text)
  TO authenticated;

-- Scheduled cleanup (pg_cron; skipped where the extension is unavailable, e.g. the local test database).
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('expire-parking', '*/15 * * * *', 'SELECT private.expire_parking()');
  ELSE
    RAISE NOTICE 'pg_cron not available: run private.expire_parking() another way';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not set up: %', SQLERRM;
END
$cron$;
