-- P8: parking spot exchange (the SpotSmiley logic, owner's request). A driver about to leave OFFERS the spot ("in 0 / 2 /
-- 5 / 10 min"); a driver looking for one CLAIMS it with a credit; the two become spot mates: each sees the other's name,
-- photo and car (make, colour, plate), live position and ETA, quick messages and push-to-talk; the taker parks and
-- confirms → the giver earns a credit + points, the taker points. Everyone starts with one credit (then: give to get).
-- No-shows / cancellations lower your reliability; 3 no-shows in a week → no exchanges for a day.
--
-- Privacy: the plate (personal data) is entered by its driver, shown ONLY to the mate of an active exchange, never
-- searchable; positions are shared with the mate only while the exchange runs (and kept on the match row only then).
-- Exchanges are kept 30 days for disputes, then deleted. Credits / points are not money (public parking is not sold).

-- ---------------------------------------------------------------------------
-- Vehicles: one per person (the one you drive now)
-- ---------------------------------------------------------------------------
CREATE TABLE private.vehicles (
  user_id uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  -- normalized: A–Z / 0–9 only (Greek letters mapped to the Latin ones they look like), 4–8 characters
  plate text NOT NULL CHECK (plate ~ '^[A-Z0-9]{4,8}$' AND plate ~ '[0-9]' AND plate ~ '[A-Z]'),
  make text CHECK (make IS NULL OR char_length(make) BETWEEN 1 AND 40),
  colour text NOT NULL CHECK (colour IN ('white', 'black', 'grey', 'silver', 'blue', 'red', 'green', 'yellow',
                                         'orange', 'brown', 'beige', 'other')),
  declared_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.vehicles ENABLE ROW LEVEL SECURITY;

-- Greek plates use the letters that look Latin (Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ): store them as those Latin letters.
CREATE FUNCTION private.normalize_plate(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT regexp_replace(
    translate(upper(coalesce(p, '')), 'ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ', 'ABEZHIKMNOPTYX'),
    '[\s\-·.]', '', 'g')
$$;

-- Your vehicle (plate required for exchanges). You declare you drive it lawfully. Errors: bad_plate, bad_input.
CREATE FUNCTION public.set_my_vehicle(p_plate text, p_make text, p_colour text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  plate text := private.normalize_plate(p_plate);
  make text := nullif(btrim(regexp_replace(coalesce(p_make, ''), '\s+', ' ', 'g')), '');
BEGIN
  IF plate !~ '^[A-Z0-9]{4,8}$' OR plate !~ '[0-9]' OR plate !~ '[A-Z]' THEN
    RAISE EXCEPTION 'bad_plate' USING ERRCODE = '22023';
  END IF;
  IF (make IS NOT NULL AND char_length(make) > 40)
     OR p_colour NOT IN ('white', 'black', 'grey', 'silver', 'blue', 'red', 'green', 'yellow', 'orange', 'brown', 'beige', 'other') THEN
    RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023';
  END IF;
  PERFORM private.rate_limit('vehicle', 10, interval '1 hour');
  INSERT INTO private.vehicles (user_id, plate, make, colour) VALUES (uid, plate, make, p_colour)
  ON CONFLICT (user_id) DO UPDATE SET plate = EXCLUDED.plate, make = EXCLUDED.make, colour = EXCLUDED.colour,
    declared_at = now(), updated_at = now();
END $$;

CREATE FUNCTION public.my_vehicle()
RETURNS TABLE (plate text, make text, colour text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT v.plate, v.make, v.colour FROM private.vehicles v WHERE v.user_id = private.me()
$$;

CREATE FUNCTION public.delete_my_vehicle()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM private.vehicles WHERE user_id = private.me();
END $$;

-- ---------------------------------------------------------------------------
-- Wallet: credits (to claim), points (for the leaderboard), reliability counters
-- ---------------------------------------------------------------------------
CREATE TABLE private.spot_wallets (
  user_id uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  credits int NOT NULL DEFAULT 1 CHECK (credits >= 0 AND credits <= 1000),
  points int NOT NULL DEFAULT 0,
  exchanges int NOT NULL DEFAULT 0,
  no_shows int NOT NULL DEFAULT 0,
  cancels int NOT NULL DEFAULT 0
);
ALTER TABLE private.spot_wallets ENABLE ROW LEVEL SECURITY;

-- Points earned, by time (weekly leaderboard); kept 30 days.
CREATE TABLE private.spot_points (
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  points int NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spot_points_at ON private.spot_points (at);
ALTER TABLE private.spot_points ENABLE ROW LEVEL SECURITY;

-- A no-show recorded against you (no place kept), for the "3 in a week" rule.
CREATE TABLE private.spot_strikes (
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spot_strikes_user ON private.spot_strikes (user_id, at);
ALTER TABLE private.spot_strikes ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION private.wallet(p_uid uuid)
RETURNS private.spot_wallets LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w private.spot_wallets;
BEGIN
  INSERT INTO private.spot_wallets (user_id) VALUES (p_uid) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO w FROM private.spot_wallets WHERE user_id = p_uid;
  RETURN w;
END $$;

CREATE FUNCTION private.add_points(p_uid uuid, p_points int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.wallet(p_uid);
  UPDATE private.spot_wallets SET points = greatest(0, points + p_points) WHERE user_id = p_uid;
  INSERT INTO private.spot_points (user_id, points) VALUES (p_uid, p_points);
END $$;

-- ---------------------------------------------------------------------------
-- Offers and matches
-- ---------------------------------------------------------------------------
CREATE TABLE private.spot_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  leave_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- open → matched → done; or cancelled / expired
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'matched', 'done', 'cancelled', 'expired')),
  ended_at timestamptz
);
CREATE UNIQUE INDEX spot_offers_one_active ON private.spot_offers (user_id) WHERE state IN ('open', 'matched');
CREATE INDEX spot_offers_box ON private.spot_offers (lat, lng) WHERE state = 'open';
ALTER TABLE private.spot_offers ENABLE ROW LEVEL SECURITY;

CREATE TABLE private.spot_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES private.spot_offers (id) ON DELETE CASCADE,
  giver uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  taker uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'done', 'cancelled', 'no_show', 'expired')),
  -- live positions of the two, only while active (cleared when it ends)
  giver_lat double precision, giver_lng double precision, giver_at timestamptz,
  taker_lat double precision, taker_lng double precision, taker_at timestamptz,
  taker_eta_s int CHECK (taker_eta_s IS NULL OR taker_eta_s BETWEEN 0 AND 7200),
  arrived_at timestamptz,
  giver_msg text, giver_msg_at timestamptz,
  taker_msg text, taker_msg_at timestamptz,
  ended_at timestamptz,
  ended_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  CHECK (giver <> taker)
);
CREATE UNIQUE INDEX spot_matches_one_active_taker ON private.spot_matches (taker) WHERE state = 'active';
CREATE INDEX spot_matches_giver ON private.spot_matches (giver) WHERE state = 'active';
ALTER TABLE private.spot_matches ENABLE ROW LEVEL SECURITY;

-- Quick messages (no typing while driving): the client shows them in the reader's language.
CREATE FUNCTION private.spot_msg_ok(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IN ('on_my_way', 'here', 'late', 'waiting', 'leaving_now', 'look_for_me', 'thanks')
$$;

-- Are a and b the two sides of an active exchange? (they may then talk, at any distance)
CREATE FUNCTION private.spot_mates(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM private.spot_matches m
                 WHERE m.state = 'active' AND ((m.giver = a AND m.taker = b) OR (m.giver = b AND m.taker = a)))
$$;

-- Push-to-talk between spot mates (the nearby voice, at any distance, while the exchange runs). Same rule as the
-- baseline otherwise: never between blocked people or with a disabled account.
CREATE OR REPLACE FUNCTION private.may_send_nearby(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a <> b AND NOT private.is_blocked(a, b)
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id IN (a, b) AND p.disabled)
     AND (private.may_talk_nearby(a, b) OR private.knocked_recently(b, a) OR private.spot_mates(a, b))
$$;

-- 3 no-shows in 7 days → no exchanges for a day after the last one.
CREATE FUNCTION private.spot_blocked(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (SELECT count(*) FROM private.spot_strikes s WHERE s.user_id = p_uid AND s.at > now() - interval '7 days') >= 3
     AND (SELECT max(s.at) FROM private.spot_strikes s WHERE s.user_id = p_uid) > now() - interval '1 day'
$$;

CREATE FUNCTION private.spot_ready(p_uid uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.vehicles WHERE user_id = p_uid) THEN
    RAISE EXCEPTION 'no_vehicle' USING ERRCODE = '42501';
  END IF;
  IF private.spot_blocked(p_uid) THEN RAISE EXCEPTION 'spot_blocked' USING ERRCODE = '42501'; END IF;
END $$;

-- End a match: positions cleared; the offer follows.
CREATE FUNCTION private.spot_end(p_match uuid, p_state text, p_by uuid)
RETURNS private.spot_matches LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m private.spot_matches;
BEGIN
  UPDATE private.spot_matches SET state = p_state, ended_at = now(), ended_by = p_by,
    giver_lat = NULL, giver_lng = NULL, giver_at = NULL, taker_lat = NULL, taker_lng = NULL, taker_at = NULL
  WHERE id = p_match AND state = 'active' RETURNING * INTO m;
  RETURN m;
END $$;

-- I'm about to leave my spot: offer it, leaving in 0 / 2 / 5 / 10 minutes. Errors: no_vehicle, spot_blocked,
-- already_active, bad_input, rate_limited.
CREATE FUNCTION public.spot_offer(p_lat double precision, p_lng double precision, p_in_min int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  oid uuid;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180
     OR p_in_min NOT IN (0, 2, 5, 10) THEN
    RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023';
  END IF;
  PERFORM private.spot_ready(uid);
  IF EXISTS (SELECT 1 FROM private.spot_offers WHERE user_id = uid AND state IN ('open', 'matched'))
     OR EXISTS (SELECT 1 FROM private.spot_matches WHERE taker = uid AND state = 'active') THEN
    RAISE EXCEPTION 'already_active' USING ERRCODE = '22023';
  END IF;
  PERFORM private.rate_limit('spot_offer', 10, interval '1 hour');
  PERFORM private.wallet(uid);
  INSERT INTO private.spot_offers (user_id, lat, lng, leave_at)
  VALUES (uid, p_lat, p_lng, now() + make_interval(mins => p_in_min)) RETURNING id INTO oid;
  RETURN oid;
END $$;

-- Open offers in a box that I may see (not mine, not between blocked people, the giver not disabled). The giver stays
-- unknown until a match.
CREATE FUNCTION public.spot_offers_in(p_min_lat double precision, p_min_lng double precision,
                                      p_max_lat double precision, p_max_lng double precision)
RETURNS TABLE (id uuid, lat double precision, lng double precision, leave_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_min_lat IS NULL OR p_max_lat IS NULL OR p_min_lng IS NULL OR p_max_lng IS NULL
     OR p_max_lat < p_min_lat OR p_max_lng < p_min_lng OR p_max_lat - p_min_lat > 0.5 OR p_max_lng - p_min_lng > 0.5 THEN
    RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT o.id, o.lat, o.lng, o.leave_at, o.created_at
  FROM private.spot_offers o
  JOIN public.profiles p ON p.id = o.user_id AND NOT p.disabled
  WHERE o.state = 'open' AND o.leave_at > now() - interval '10 minutes' AND o.user_id <> uid
    AND o.lat BETWEEN p_min_lat AND p_max_lat AND o.lng BETWEEN p_min_lng AND p_max_lng
    AND NOT private.is_blocked(uid, o.user_id)
  ORDER BY o.leave_at
  LIMIT 100;
END $$;

-- I want that spot: one credit; the first claim wins. I must be within 5 km of it. Errors: no_vehicle, spot_blocked,
-- no_credits, taken, too_far, already_active, own_offer, rate_limited.
CREATE FUNCTION public.spot_claim(p_offer uuid, p_lat double precision, p_lng double precision)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  o private.spot_offers;
  mid uuid;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023'; END IF;
  PERFORM private.spot_ready(uid);
  IF EXISTS (SELECT 1 FROM private.spot_offers WHERE user_id = uid AND state IN ('open', 'matched'))
     OR EXISTS (SELECT 1 FROM private.spot_matches WHERE taker = uid AND state = 'active') THEN
    RAISE EXCEPTION 'already_active' USING ERRCODE = '22023';
  END IF;
  PERFORM private.rate_limit('spot_claim', 20, interval '1 hour');
  -- lock the offer: of two claims at once, one waits here and then finds it taken
  SELECT * INTO o FROM private.spot_offers WHERE id = p_offer FOR UPDATE;
  IF NOT FOUND OR o.state <> 'open' OR o.leave_at <= now() - interval '10 minutes'
     OR private.is_blocked(uid, o.user_id)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE id = o.user_id AND disabled) THEN
    RAISE EXCEPTION 'taken' USING ERRCODE = 'P0002';
  END IF;
  IF o.user_id = uid THEN RAISE EXCEPTION 'own_offer' USING ERRCODE = '42501'; END IF;
  IF private.distance_m(o.lat, o.lng, p_lat, p_lng) > 5000 THEN RAISE EXCEPTION 'too_far' USING ERRCODE = '22023'; END IF;
  IF (private.wallet(uid)).credits < 1 THEN RAISE EXCEPTION 'no_credits' USING ERRCODE = '42501'; END IF;
  UPDATE private.spot_wallets SET credits = credits - 1 WHERE user_id = uid;
  UPDATE private.spot_offers SET state = 'matched' WHERE id = o.id;
  INSERT INTO private.spot_matches (offer_id, giver, taker, taker_lat, taker_lng, taker_at)
  VALUES (o.id, o.user_id, uid, p_lat, p_lng, now()) RETURNING id INTO mid;
  RETURN mid;
END $$;

-- My exchange right now, for the screen (polled every few seconds while one runs): my role, the offer, the match with
-- the mate's name / photo / car / live position (≤ 2 min old) / ETA / last quick message, and my wallet.
CREATE FUNCTION public.spot_state()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  w private.spot_wallets;
  o private.spot_offers;
  m private.spot_matches;
  mate uuid;
  role text;
  res jsonb;
BEGIN
  SELECT * INTO w FROM private.spot_wallets WHERE user_id = uid;
  res := jsonb_build_object('wallet', jsonb_build_object(
    'credits', coalesce(w.credits, 1), 'points', coalesce(w.points, 0), 'exchanges', coalesce(w.exchanges, 0),
    'reliability', CASE WHEN coalesce(w.exchanges, 0) + coalesce(w.no_shows, 0) + coalesce(w.cancels, 0) = 0 THEN 100
                        ELSE round(100.0 * w.exchanges / (w.exchanges + w.no_shows + w.cancels)) END,
    'blocked', private.spot_blocked(uid),
    'vehicle', EXISTS (SELECT 1 FROM private.vehicles WHERE user_id = uid)));
  SELECT * INTO m FROM private.spot_matches WHERE state = 'active' AND (giver = uid OR taker = uid) LIMIT 1;
  IF m.id IS NULL THEN
    -- the last exchange that ended in the last 2 minutes (so both screens see how it ended)
    SELECT * INTO m FROM private.spot_matches
    WHERE (giver = uid OR taker = uid) AND ended_at > now() - interval '2 minutes' ORDER BY ended_at DESC LIMIT 1;
  END IF;
  SELECT * INTO o FROM private.spot_offers WHERE user_id = uid AND state IN ('open', 'matched') LIMIT 1;
  IF o.id IS NULL AND m.id IS NOT NULL THEN SELECT * INTO o FROM private.spot_offers WHERE id = m.offer_id; END IF;
  IF o.id IS NOT NULL THEN
    res := res || jsonb_build_object('offer', jsonb_build_object('id', o.id, 'lat', o.lat, 'lng', o.lng,
      'leave_at', o.leave_at, 'state', o.state));
  END IF;
  IF m.id IS NULL THEN RETURN res; END IF;
  role := CASE WHEN m.giver = uid THEN 'giver' ELSE 'taker' END;
  mate := CASE WHEN role = 'giver' THEN m.taker ELSE m.giver END;
  res := res || jsonb_build_object('match', (
    SELECT jsonb_build_object(
      'id', m.id, 'role', role, 'state', m.state, 'created_at', m.created_at, 'ended_at', m.ended_at,
      'ended_by_me', m.ended_by = uid,
      'arrived_at', m.arrived_at, 'eta_s', m.taker_eta_s,
      'mate', jsonb_build_object('user_id', p.id, 'username', p.username, 'full_name', p.full_name,
        'avatar_path', p.avatar_path,
        -- the car only while the exchange runs
        'plate', CASE WHEN m.state = 'active' THEN v.plate END,
        'make', CASE WHEN m.state = 'active' THEN v.make END,
        'colour', CASE WHEN m.state = 'active' THEN v.colour END),
      'mate_pos', CASE
        WHEN role = 'giver' AND m.taker_at > now() - interval '2 minutes' THEN jsonb_build_object('lat', m.taker_lat, 'lng', m.taker_lng, 'at', m.taker_at)
        WHEN role = 'taker' AND m.giver_at > now() - interval '2 minutes' THEN jsonb_build_object('lat', m.giver_lat, 'lng', m.giver_lng, 'at', m.giver_at)
      END,
      'mate_msg', CASE WHEN role = 'giver' THEN m.taker_msg ELSE m.giver_msg END,
      'mate_msg_at', CASE WHEN role = 'giver' THEN m.taker_msg_at ELSE m.giver_msg_at END,
      'my_msg', CASE WHEN role = 'giver' THEN m.giver_msg ELSE m.taker_msg END)
    FROM public.profiles p LEFT JOIN private.vehicles v ON v.user_id = p.id WHERE p.id = mate));
  RETURN res;
END $$;

-- While an exchange runs: my position (≤ 1 a second; for the mate's map) and, as the taker, my ETA. The taker within
-- 60 m of the spot = arrived. Errors: no_match.
CREATE FUNCTION public.spot_update(p_lat double precision, p_lng double precision, p_eta_s int DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  m private.spot_matches;
  o private.spot_offers;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO m FROM private.spot_matches WHERE state = 'active' AND (giver = uid OR taker = uid) LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_match' USING ERRCODE = 'P0002'; END IF;
  -- (positions at most about one a second; the ETA and the arrival are always taken)
  IF m.giver = uid THEN
    IF m.giver_at > now() - interval '900 milliseconds' THEN RETURN; END IF;
    UPDATE private.spot_matches SET giver_lat = p_lat, giver_lng = p_lng, giver_at = now() WHERE id = m.id;
  ELSE
    SELECT * INTO o FROM private.spot_offers WHERE id = m.offer_id;
    UPDATE private.spot_matches SET
      taker_lat = CASE WHEN taker_at > now() - interval '900 milliseconds' THEN taker_lat ELSE p_lat END,
      taker_lng = CASE WHEN taker_at > now() - interval '900 milliseconds' THEN taker_lng ELSE p_lng END,
      taker_at = CASE WHEN taker_at > now() - interval '900 milliseconds' THEN taker_at ELSE now() END,
      taker_eta_s = CASE WHEN p_eta_s BETWEEN 0 AND 7200 THEN p_eta_s ELSE taker_eta_s END,
      arrived_at = coalesce(arrived_at, CASE WHEN private.distance_m(o.lat, o.lng, p_lat, p_lng) <= 60 THEN now() END)
    WHERE id = m.id;
  END IF;
END $$;

-- A quick message to my mate. Errors: no_match, bad_input, rate_limited.
CREATE FUNCTION public.spot_message(p_msg text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  m private.spot_matches;
BEGIN
  IF NOT private.spot_msg_ok(p_msg) THEN RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO m FROM private.spot_matches WHERE state = 'active' AND (giver = uid OR taker = uid) LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_match' USING ERRCODE = 'P0002'; END IF;
  PERFORM private.rate_limit('spot_msg', 30, interval '10 minutes');
  IF m.giver = uid THEN UPDATE private.spot_matches SET giver_msg = p_msg, giver_msg_at = now() WHERE id = m.id;
  ELSE UPDATE private.spot_matches SET taker_msg = p_msg, taker_msg_at = now() WHERE id = m.id;
  END IF;
END $$;

-- The taker parked in the spot: done. The giver +1 credit, +10 points; the taker +5 points; both one more exchange.
-- Errors: no_match, not_taker.
CREATE FUNCTION public.spot_done()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  m private.spot_matches;
BEGIN
  SELECT * INTO m FROM private.spot_matches WHERE state = 'active' AND (giver = uid OR taker = uid) LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_match' USING ERRCODE = 'P0002'; END IF;
  IF m.taker <> uid THEN RAISE EXCEPTION 'not_taker' USING ERRCODE = '42501'; END IF;
  PERFORM private.spot_end(m.id, 'done', uid);
  UPDATE private.spot_offers SET state = 'done', ended_at = now() WHERE id = m.offer_id;
  PERFORM private.wallet(m.giver);
  UPDATE private.spot_wallets SET credits = least(credits + 1, 1000), exchanges = exchanges + 1 WHERE user_id = m.giver;
  UPDATE private.spot_wallets SET exchanges = exchanges + 1 WHERE user_id = m.taker;
  PERFORM private.add_points(m.giver, 10);
  PERFORM private.add_points(m.taker, 5);
END $$;

-- Cancel (either side) — or, with p_no_show, say the other didn't turn up:
--   giver cancels: the taker's credit back; the giver's cancellations +1 (reliability);
--   taker cancels: the credit back only within 2 minutes of the match; the offer opens again if still in time;
--   taker: "the giver wasn't there" (only after arriving): credit back, a no-show + strike + −10 points for the giver;
--   giver: "nobody came" (only 10 minutes after the match and without an arrival): a no-show + strike for the taker.
-- Errors: no_match, too_early.
CREATE FUNCTION public.spot_cancel(p_no_show boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  m private.spot_matches;
  o private.spot_offers;
  culprit uuid;
BEGIN
  SELECT * INTO m FROM private.spot_matches WHERE state = 'active' AND (giver = uid OR taker = uid) LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    -- no match: cancel my open offer, if any (no penalty before someone claimed it)
    UPDATE private.spot_offers SET state = 'cancelled', ended_at = now() WHERE user_id = uid AND state = 'open';
    IF NOT FOUND THEN RAISE EXCEPTION 'no_match' USING ERRCODE = 'P0002'; END IF;
    RETURN;
  END IF;
  SELECT * INTO o FROM private.spot_offers WHERE id = m.offer_id FOR UPDATE;
  PERFORM private.wallet(m.giver);
  PERFORM private.wallet(m.taker);
  IF p_no_show THEN
    IF m.taker = uid AND m.arrived_at IS NULL THEN RAISE EXCEPTION 'too_early' USING ERRCODE = '22023'; END IF;
    IF m.giver = uid AND (m.arrived_at IS NOT NULL OR m.created_at > now() - interval '10 minutes') THEN
      RAISE EXCEPTION 'too_early' USING ERRCODE = '22023';
    END IF;
    culprit := CASE WHEN m.taker = uid THEN m.giver ELSE m.taker END;
    PERFORM private.spot_end(m.id, 'no_show', uid);
    UPDATE private.spot_offers SET state = 'cancelled', ended_at = now() WHERE id = o.id;
    IF m.taker = uid THEN UPDATE private.spot_wallets SET credits = least(credits + 1, 1000) WHERE user_id = m.taker; END IF;
    UPDATE private.spot_wallets SET no_shows = no_shows + 1 WHERE user_id = culprit;
    INSERT INTO private.spot_strikes (user_id) VALUES (culprit);
    PERFORM private.add_points(culprit, -10);
    RETURN;
  END IF;
  PERFORM private.spot_end(m.id, 'cancelled', uid);
  IF m.giver = uid THEN
    UPDATE private.spot_offers SET state = 'cancelled', ended_at = now() WHERE id = o.id;
    UPDATE private.spot_wallets SET credits = least(credits + 1, 1000) WHERE user_id = m.taker;
    UPDATE private.spot_wallets SET cancels = cancels + 1 WHERE user_id = m.giver;
  ELSE
    IF m.created_at > now() - interval '2 minutes' THEN
      UPDATE private.spot_wallets SET credits = least(credits + 1, 1000) WHERE user_id = m.taker;
    ELSE
      UPDATE private.spot_wallets SET cancels = cancels + 1 WHERE user_id = m.taker;
    END IF;
    UPDATE private.spot_offers SET state = CASE WHEN leave_at > now() - interval '5 minutes' THEN 'open' ELSE 'expired' END,
      ended_at = CASE WHEN leave_at > now() - interval '5 minutes' THEN NULL ELSE now() END
    WHERE id = o.id;
  END IF;
END $$;

-- This week's top 20 by points earned (name and photo; 7 days), and my own rank.
CREATE FUNCTION public.spot_leaderboard()
RETURNS TABLE (rank int, user_id uuid, username text, full_name text, avatar_path text, points int, me boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  WITH week AS (
    SELECT s.user_id, sum(s.points)::int AS pts FROM private.spot_points s
    WHERE s.at > now() - interval '7 days' GROUP BY s.user_id HAVING sum(s.points) > 0
  ), ranked AS (
    SELECT (row_number() OVER (ORDER BY w.pts DESC, w.user_id))::int AS rnk, w.user_id, w.pts FROM week w
    JOIN public.profiles p ON p.id = w.user_id AND NOT p.disabled
    WHERE NOT private.is_blocked(uid, w.user_id)
  )
  SELECT r.rnk, r.user_id, p.username, p.full_name, p.avatar_path, r.pts, r.user_id = uid
  FROM ranked r JOIN public.profiles p ON p.id = r.user_id
  WHERE r.rnk <= 20 OR r.user_id = uid
  ORDER BY r.rnk;
END $$;

-- A block during an exchange ends it (the taker's credit back; nobody penalised).
CREATE FUNCTION private.on_block_spot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m private.spot_matches;
BEGIN
  FOR m IN SELECT * FROM private.spot_matches WHERE state = 'active'
    AND ((giver = NEW.blocker_id AND taker = NEW.blocked_id) OR (giver = NEW.blocked_id AND taker = NEW.blocker_id))
  LOOP
    PERFORM private.spot_end(m.id, 'cancelled', NEW.blocker_id);
    UPDATE private.spot_offers SET state = 'cancelled', ended_at = now() WHERE id = m.offer_id;
    PERFORM private.wallet(m.taker);
    UPDATE private.spot_wallets SET credits = least(credits + 1, 1000) WHERE user_id = m.taker;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER blocks_end_spot AFTER INSERT ON public.blocks FOR EACH ROW EXECUTE FUNCTION private.on_block_spot();

-- Housekeeping: open offers 10 min past their time → expired; active exchanges after 30 min → expired (the taker's
-- credit back); ended offers / exchanges / points after 30 days and strikes after 7 → deleted.
CREATE FUNCTION private.expire_spots()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m private.spot_matches;
BEGIN
  UPDATE private.spot_offers SET state = 'expired', ended_at = now()
  WHERE state = 'open' AND leave_at < now() - interval '10 minutes';
  FOR m IN SELECT * FROM private.spot_matches WHERE state = 'active' AND created_at < now() - interval '30 minutes' LOOP
    PERFORM private.spot_end(m.id, 'expired', NULL);
    UPDATE private.spot_offers SET state = 'expired', ended_at = now() WHERE id = m.offer_id;
    PERFORM private.wallet(m.taker);
    UPDATE private.spot_wallets SET credits = least(credits + 1, 1000) WHERE user_id = m.taker;
  END LOOP;
  DELETE FROM private.spot_matches WHERE state <> 'active' AND ended_at < now() - interval '30 days';
  DELETE FROM private.spot_offers WHERE state NOT IN ('open', 'matched') AND coalesce(ended_at, created_at) < now() - interval '30 days';
  DELETE FROM private.spot_points WHERE at < now() - interval '30 days';
  DELETE FROM private.spot_strikes WHERE at < now() - interval '7 days';
END $$;

-- Privileges (as the baseline's section 12).
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA private TO service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_blocked(uuid, uuid), private.walkie_topic_ok(text), private.nearby_topic_ok(text)
  TO authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('expire-spots', '* * * * *', 'SELECT private.expire_spots()');
  ELSE
    RAISE NOTICE 'pg_cron not available: run private.expire_spots() another way';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not set up: %', SQLERRM;
END
$cron$;
