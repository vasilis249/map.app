-- Baseline for the social navigation app (map + people nearby + push to talk).
-- Ported from the Speak starter kit (maps-kit/db/migrations-reference, now docs/kit/): the function bodies and RLS
-- policies are Speak's, production-tested; names and the schema are this app's.
--
-- Rules of thumb:
--  * RLS on every table; clients only SELECT (plus a few column-level UPDATE grants).
--  * Every write goes through a SECURITY DEFINER RPC in `public` that checks the caller (private.me()).
--  * SECURITY DEFINER functions always `SET search_path = ''` and use schema-qualified names.
--  * Helpers live in `private` (not exposed by the Data API). EXECUTE on them is revoked; only the few that RLS
--    policies call are granted back to `authenticated`.
--  * Location: only the latest position per user, never a history; hidden after 15 min, deleted after 1 h.
--    "Near" = within private.near_m() metres (200), always measured on the server from the caller's own stored
--    position.

-- ---------------------------------------------------------------------------
-- 1. Private schema: rate limits, helpers
-- ---------------------------------------------------------------------------
CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
-- Needed so RLS policies (evaluated as the caller) can use the granted helpers below.
-- The schema is not exposed by the Data API, so nothing here is callable over HTTP.
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE TABLE private.rate_events (
  user_id uuid NOT NULL,
  action text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_events_lookup ON private.rate_events (user_id, action, at);
ALTER TABLE private.rate_events ENABLE ROW LEVEL SECURITY;

-- Raises `rate_limited` (HINT = the action) once the caller did `p_action` p_max times within p_window.
CREATE FUNCTION private.rate_limit(p_action text, p_max int, p_window interval)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT count(*) FROM private.rate_events
      WHERE user_id = auth.uid() AND action = p_action AND at > now() - p_window) >= p_max THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001', HINT = p_action;
  END IF;
  INSERT INTO private.rate_events (user_id, action) VALUES (auth.uid(), p_action);
END $$;

-- Greek → Latin, lower case, words joined with ".", only [a-z0-9._], max 20 chars,
-- no dots/underscores at the ends (e.g. "Μαρία Παπαδοπούλου" → "maria.papadopoulou").
CREATE FUNCTION private.slugify(t text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT trim(BOTH '._' FROM left(trim(BOTH '._' FROM regexp_replace(regexp_replace(regexp_replace(translate(
    replace(replace(replace(replace(replace(replace(lower(coalesce(t, '')),
      'ού', 'ou'), 'ου', 'ou'), 'θ', 'th'), 'χ', 'ch'), 'ψ', 'ps'), 'ξ', 'x'),
    'αάβγδεέζηήιίϊΐκλμνοόπρσςτυύϋΰφωώ',
    'aavgdeeziiiiiiklmnooprsstyyyyfoo'),
    '\s+', '.', 'g'), '[^a-z0-9._]', '', 'g'), '\.{2,}', '.', 'g')), 20))
$$;

-- "Near you" on the map, for push to talk and the strangers layer (metres).
CREATE FUNCTION private.near_m()
RETURNS int LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 200 $$;

-- Great-circle distance in metres.
CREATE FUNCTION private.distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))
$$;

-- Audio formats accepted for saved transmissions (normalized, parameters dropped).
CREATE FUNCTION private.normalize_audio_mime(p_mime text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE m text := lower(trim(split_part(coalesce(p_mime, ''), ';', 1)));
BEGIN
  IF m NOT IN ('audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/webm', 'audio/ogg') THEN
    RAISE EXCEPTION 'bad_audio_type' USING ERRCODE = '22023';
  END IF;
  RETURN m;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Profiles (created by a trigger on auth.users)
-- ---------------------------------------------------------------------------
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._]{3,20}$'),
  full_name text NOT NULL DEFAULT '' CHECK (char_length(full_name) <= 60),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 160),
  avatar_path text CHECK (avatar_path IS NULL OR char_length(avatar_path) <= 200),
  disabled boolean NOT NULL DEFAULT false,
  -- The person declared they are 18 or older (the app shows exact positions to strangers nearby). Set at sign-up
  -- (user metadata age_confirmed = true) or later through confirm_age(); nothing works before it (private.me()).
  age_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION private.create_profile(p_id uuid, p_email text, p_meta jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  base text;
  candidate text;
  tries int := 0;
BEGIN
  base := private.slugify(coalesce(nullif(p_meta ->> 'username', ''), nullif(p_meta ->> 'full_name', ''),
                                   split_part(coalesce(p_email, ''), '@', 1)));
  IF char_length(base) < 3 THEN base := 'user' || base; END IF;
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = candidate) LOOP
    tries := tries + 1;
    candidate := CASE WHEN tries < 20 THEN left(base, 16) || (1000 + floor(random() * 9000))::int::text
                      ELSE 'user' || substr(md5(random()::text), 1, 12) END;
  END LOOP;
  INSERT INTO public.profiles (id, username, full_name, age_confirmed_at)
  VALUES (p_id, candidate, left(coalesce(p_meta ->> 'full_name', ''), 60),
          CASE WHEN p_meta ->> 'age_confirmed' = 'true' THEN now() END)
  ON CONFLICT (id) DO NOTHING;
END $$;

CREATE FUNCTION private.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.create_profile(NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data, '{}'::jsonb));
  RETURN NEW;
END $$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION private.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3. Follows (public, asymmetric, no approval; mutual = friends), blocks, admins
-- ---------------------------------------------------------------------------
CREATE TABLE public.follows (
  follower_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee ON public.follows (followee_id, created_at DESC);

CREATE TABLE public.blocks (
  blocker_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked ON public.blocks (blocked_id);

-- Moderators. Granted by SQL only.
CREATE TABLE private.admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.admins ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION private.follows(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.follows WHERE follower_id = a AND followee_id = b)
$$;

-- Friends = they follow each other.
CREATE FUNCTION private.are_friends(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.follows(a, b) AND private.follows(b, a)
$$;

-- Either one blocked the other.
CREATE FUNCTION private.is_blocked(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocks
    WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id = b AND blocked_id = a))
$$;

CREATE FUNCTION private.is_admin(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM private.admins WHERE user_id = p_user)
$$;

-- Raises unless the caller is signed in, not disabled and declared 18+. Returns the caller's id.
CREATE FUNCTION private.me()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := auth.uid();
  p public.profiles;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id = uid;
  IF uid IS NULL OR NOT FOUND OR p.disabled THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p.age_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'age_not_confirmed' USING ERRCODE = '42501';
  END IF;
  RETURN uid;
END $$;

-- "I am 18 or older" (accounts created without the sign-up checkbox, e.g. Sign in with Apple later).
CREATE FUNCTION public.confirm_age()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  UPDATE public.profiles SET age_confirmed_at = coalesce(age_confirmed_at, now()) WHERE id = uid AND NOT disabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. In-app notifications (the bell): follows, map talk (nearby), missed walkie transmissions
-- ---------------------------------------------------------------------------
CREATE TABLE public.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('follow', 'nearby', 'walkie')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_user ON public.notifications (user_id, created_at DESC);

-- One row per (recipient, actor, kind): a repeat moves to the top instead of piling up. Never across a block.
CREATE FUNCTION private.notify(p_user uuid, p_actor uuid, p_kind text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user IS NULL OR p_user = p_actor OR private.is_blocked(p_user, p_actor) THEN RETURN; END IF;
  DELETE FROM public.notifications WHERE user_id = p_user AND actor_id = p_actor AND kind = p_kind;
  INSERT INTO public.notifications (user_id, actor_id, kind) VALUES (p_user, p_actor, p_kind);
END $$;

CREATE FUNCTION private.notify_follow()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.notify(NEW.followee_id, NEW.follower_id, 'follow');
  RETURN NEW;
END $$;
CREATE TRIGGER follows_notify AFTER INSERT ON public.follows FOR EACH ROW EXECUTE FUNCTION private.notify_follow();

-- ---------------------------------------------------------------------------
-- 5. Reports (UGC moderation; queue for admins)
-- ---------------------------------------------------------------------------
CREATE TABLE public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  target_user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('user', 'walkie', 'nearby')),
  target_id uuid,
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX reports_open ON public.reports (created_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6. Location sharing (live map)
--   - off by default; off | friends (mutual follows, any distance) | everyone (friends + anyone within near_m());
--   - reciprocity: to see anyone you must be sharing too, with a fresh position;
--   - the radius is measured from YOUR stored position, never from a point the client picks;
--   - only the latest position is kept (no history); hidden after 15 min (friends: last known up to 1 h),
--     deleted after 1 h; turning sharing off deletes it at once;
--   - blocks hide both people from each other; disabled accounts are hidden.
-- ---------------------------------------------------------------------------
CREATE TABLE public.location_sharing (
  user_id uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'friends', 'everyone')),
  talk_from text NOT NULL DEFAULT 'everyone' CHECK (talk_from IN ('everyone', 'following', 'nobody')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

-- Your sharing settings and your own latest position (the map centres on it).
CREATE FUNCTION public.my_location_sharing()
RETURNS TABLE (mode text, talk_from text, has_position boolean, position_at timestamptz, lat double precision,
               lng double precision, accuracy_m real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(s.mode, 'off'), coalesce(s.talk_from, 'everyone'), l.user_id IS NOT NULL, l.updated_at, l.lat, l.lng,
         l.accuracy_m
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
    DELETE FROM private.user_locations WHERE user_id = uid; -- turning it off (ghost mode) forgets where you were
  END IF;
END $$;

-- The app reports where you are (foreground watch or the background plugin). Ignored while sharing is off;
-- about one stored write per second (driving sends every ~1 s; anything faster is dropped, not an error; the 0.9 s
-- floor leaves room for network jitter between two 1 s sends).
CREATE FUNCTION public.update_my_location(p_lat double precision, p_lng double precision, p_accuracy real DEFAULT NULL,
                                          p_heading real DEFAULT NULL, p_speed real DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  -- (NaN is larger than every number in Postgres, so BETWEEN refuses it too.)
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'bad_location' USING ERRCODE = '22023';
  END IF;
  IF coalesce((SELECT mode FROM public.location_sharing WHERE user_id = uid), 'off') = 'off' THEN RETURN false; END IF;
  INSERT INTO private.user_locations AS l (user_id, lat, lng, accuracy_m, heading, speed, updated_at)
  VALUES (uid, p_lat, p_lng,
          CASE WHEN p_accuracy >= 0 AND p_accuracy < 100000 THEN p_accuracy END,
          CASE WHEN p_heading >= 0 AND p_heading < 360 THEN p_heading END,
          CASE WHEN p_speed >= 0 AND p_speed < 150 THEN p_speed END,
          now())
  ON CONFLICT (user_id) DO UPDATE
    SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy_m = EXCLUDED.accuracy_m, heading = EXCLUDED.heading,
        speed = EXCLUDED.speed, updated_at = now()
    WHERE l.updated_at < now() - interval '900 milliseconds';
  RETURN true;
END $$;

-- Are these two people within near_m() of each other right now, both sharing with everyone (or friends sharing)?
-- Used by push to talk on the map.
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
      AND private.distance_m(la.lat, la.lng, lb.lat, lb.lng) <= private.near_m())
$$;

CREATE FUNCTION private.expire_locations()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM private.user_locations WHERE updated_at < now() - interval '1 hour'
$$;

-- ---------------------------------------------------------------------------
-- 7. Push to talk with someone near you ("knock then talk")
--   Knock: pressing the button first calls nearby_knock(them). The server checks that you may talk to them right now
--   (both sharing, ≤ near_m(), not blocked, their "who can talk to you" setting) and signals their phone through its
--   private inbox topic `nearby-in:<their id>` (realtime.send, server side only — nobody can write into an inbox).
--   Their app then joins the pair channel `nearby:<smaller id>:<larger id>` and hears you live (the first words wait
--   on your phone until they are there).
--   Pair channel: only the two may join; allowed while they may talk (either way) or for 5 minutes after a knock
--   between them, so an answer still arrives when the light turns green and one of you drives on.
--   Replies: whoever talked to you may be answered for 5 minutes, whatever their own setting.
--   Kept: each transmission is saved for 24 h (replay, reports), then deleted.
--   Anti-spam: 60 knocks a minute, at most 30 different people an hour.
-- ---------------------------------------------------------------------------
CREATE TABLE private.nearby_knocks (
  sender_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_id, recipient_id),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX nearby_knocks_sender_time ON private.nearby_knocks (sender_id, created_at);
ALTER TABLE private.nearby_knocks ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.nearby_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  duration_ms int NOT NULL CHECK (duration_ms BETWEEN 300 AND 60000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX nearby_messages_pair ON public.nearby_messages
  (least(sender_id, recipient_id), greatest(sender_id, recipient_id), created_at DESC);
CREATE INDEX nearby_messages_recent ON public.nearby_messages (created_at);

CREATE TABLE private.nearby_audio (
  message_id uuid PRIMARY KEY REFERENCES public.nearby_messages (id) ON DELETE CASCADE,
  mime text NOT NULL,
  audio bytea NOT NULL
);
ALTER TABLE private.nearby_audio ENABLE ROW LEVEL SECURITY;

-- May `a` talk to `b` from the map right now? Near each other (are_nearby), nobody disabled, and b's setting lets a in.
CREATE FUNCTION private.may_talk_nearby(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.are_nearby(a, b)
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id IN (a, b) AND p.disabled)
     AND EXISTS (SELECT 1 FROM public.location_sharing s WHERE s.user_id = b
                 AND (s.talk_from = 'everyone' OR (s.talk_from = 'following' AND private.follows(b, a))))
$$;

-- Did `a` knock `b` in the last 5 minutes (so b may answer, and the pair channel stays open)?
CREATE FUNCTION private.knocked_recently(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM private.nearby_knocks k
                 WHERE k.sender_id = a AND k.recipient_id = b AND k.created_at > now() - interval '5 minutes')
$$;

-- `a` may send to `b`: allowed now, or b talked to a in the last 5 minutes (an answer). Never across a block.
CREATE FUNCTION private.may_send_nearby(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a <> b AND NOT private.is_blocked(a, b)
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id IN (a, b) AND p.disabled)
     AND (private.may_talk_nearby(a, b) OR private.knocked_recently(b, a))
$$;

-- Realtime: may the signed-in user join / send on this pair topic? Only its two people, canonical form, and only
-- while one of them may talk to the other or a knock between them is less than 5 minutes old.
CREATE FUNCTION private.nearby_topic_ok(p_topic text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := auth.uid();
  m text[];
  a uuid;
  b uuid;
  other uuid;
BEGIN
  m := regexp_match(coalesce(p_topic, ''),
    '^nearby:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  IF m IS NULL OR uid IS NULL THEN RETURN false; END IF;
  a := m[1]::uuid;
  b := m[2]::uuid;
  IF NOT (a < b AND uid IN (a, b)) THEN RETURN false; END IF;
  other := CASE WHEN uid = a THEN b ELSE a END;
  -- may_send_nearby(other, uid) also covers "I knocked them in the last 5 minutes" (they may answer).
  RETURN private.may_send_nearby(uid, other) OR private.may_send_nearby(other, uid);
END $$;

-- Who is on your map: friends sharing with friends or everyone (any distance, last known position up to 1 h), and
-- people sharing with everyone within p_radius_m (50–near_m()) of your own position, with positions less than
-- 15 min old from both of you. You must be sharing. can_talk: ≤ near_m(), fresh, their setting lets you in — or
-- they talked to you in the last 5 minutes (you may answer).
CREATE FUNCTION public.map_people(p_radius_m int DEFAULT 200)
RETURNS TABLE (user_id uuid, username text, full_name text, avatar_path text, lat double precision,
               lng double precision, accuracy_m real, heading real, updated_at timestamptz, distance_m int,
               is_friend boolean, can_talk boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  me_loc private.user_locations;
  me_fresh boolean;
  near int := private.near_m();
  r int := least(greatest(coalesce(p_radius_m, near), 50), near);
  dlat double precision;
  dlng double precision;
BEGIN
  IF coalesce((SELECT ls.mode FROM public.location_sharing ls WHERE ls.user_id = uid), 'off') = 'off' THEN RETURN; END IF;
  -- Reciprocity: you share too, with a position of the last hour (friends) / 15 minutes (everyone else).
  SELECT * INTO me_loc FROM private.user_locations ul WHERE ul.user_id = uid AND ul.updated_at > now() - interval '1 hour';
  IF NOT FOUND THEN RETURN; END IF;
  me_fresh := me_loc.updated_at > now() - interval '15 minutes';
  dlat := r / 111320.0;
  dlng := r / (111320.0 * greatest(cos(radians(me_loc.lat)), 0.01));
  RETURN QUERY
  WITH cand AS (
    SELECT l.*, s.mode, s.talk_from, private.are_friends(uid, l.user_id) AS friend,
           private.distance_m(me_loc.lat, me_loc.lng, l.lat, l.lng) AS dist
    FROM private.user_locations l
    JOIN public.location_sharing s ON s.user_id = l.user_id AND s.mode <> 'off'
    JOIN public.profiles p ON p.id = l.user_id AND NOT p.disabled
    WHERE l.user_id <> uid AND l.updated_at > now() - interval '1 hour'
      AND NOT private.is_blocked(uid, l.user_id)
  )
  SELECT c.user_id, p.username, p.full_name, p.avatar_path, c.lat, c.lng, c.accuracy_m, c.heading, c.updated_at,
         round(c.dist)::int,
         c.friend,
         (c.dist <= near AND c.updated_at > now() - interval '15 minutes' AND me_fresh
          AND (c.talk_from = 'everyone' OR (c.talk_from = 'following' AND private.follows(c.user_id, uid))))
           OR private.knocked_recently(c.user_id, uid)
  FROM cand c JOIN public.profiles p ON p.id = c.user_id
  WHERE (c.friend AND c.mode IN ('friends', 'everyone'))
     OR (c.mode = 'everyone' AND me_fresh AND c.updated_at > now() - interval '15 minutes'
         AND c.lat BETWEEN me_loc.lat - dlat AND me_loc.lat + dlat
         AND c.lng BETWEEN me_loc.lng - dlng AND me_loc.lng + dlng
         AND c.dist <= r)
  ORDER BY 10
  LIMIT 200;
END $$;

-- Before each transmission: may I talk to them? If so their phone is told to join (who, how far). Errors:
-- not_nearby (moved away, their setting, blocked…), too_many_people (30 different people an hour), rate_limited.
CREATE FUNCTION public.nearby_knock(p_to uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  me_p public.profiles;
  dist int;
BEGIN
  IF p_to IS NULL OR NOT private.may_send_nearby(uid, p_to) THEN
    RAISE EXCEPTION 'not_nearby' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM private.nearby_knocks WHERE sender_id = uid AND recipient_id = p_to
                 AND created_at > now() - interval '1 hour')
     AND (SELECT count(*) FROM private.nearby_knocks WHERE sender_id = uid AND created_at > now() - interval '1 hour') >= 30 THEN
    RAISE EXCEPTION 'too_many_people' USING ERRCODE = '22023';
  END IF;
  PERFORM private.rate_limit('nearby_knock', 60, interval '1 minute');
  INSERT INTO private.nearby_knocks (sender_id, recipient_id) VALUES (uid, p_to)
  ON CONFLICT (sender_id, recipient_id) DO UPDATE SET created_at = now();
  SELECT * INTO me_p FROM public.profiles WHERE id = uid;
  SELECT round(private.distance_m(la.lat, la.lng, lb.lat, lb.lng))::int INTO dist
  FROM private.user_locations la, private.user_locations lb WHERE la.user_id = uid AND lb.user_id = p_to;
  PERFORM realtime.send(
    jsonb_build_object('from', uid, 'username', me_p.username, 'full_name', me_p.full_name,
                       'avatar_path', me_p.avatar_path, 'distance_m', dist, 'at', now()),
    'knock', 'nearby-in:' || p_to::text, true);
END $$;

-- Save a transmission (heard live already) for 24 h: replay and reports. Needs a knock to them in the last 5 minutes.
CREATE FUNCTION public.send_nearby(p_to uuid, p_audio_b64 text, p_mime text, p_duration_ms int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  bytes bytea;
  mid uuid;
BEGIN
  IF p_to IS NULL OR NOT private.knocked_recently(uid, p_to) OR private.is_blocked(uid, p_to)
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_to AND NOT disabled) THEN
    RAISE EXCEPTION 'not_nearby' USING ERRCODE = '42501';
  END IF;
  IF p_audio_b64 IS NULL OR char_length(p_audio_b64) > 2100000 THEN
    RAISE EXCEPTION 'audio_too_large' USING ERRCODE = '22023';
  END IF;
  bytes := decode(p_audio_b64, 'base64');
  IF octet_length(bytes) < 100 OR octet_length(bytes) > 1572864 THEN
    RAISE EXCEPTION 'audio_too_large' USING ERRCODE = '22023';
  END IF;
  PERFORM private.rate_limit('nearby_save', 60, interval '1 minute');
  PERFORM private.rate_limit('nearby_day', 1000, interval '1 day');
  INSERT INTO public.nearby_messages (sender_id, recipient_id, duration_ms)
  VALUES (uid, p_to, least(greatest(coalesce(p_duration_ms, 300), 300), 60000)) RETURNING id INTO mid;
  INSERT INTO private.nearby_audio (message_id, mime, audio) VALUES (mid, private.normalize_audio_mime(p_mime), bytes);
  RETURN mid;
END $$;

-- Replay one (either of the two, within 24 h).
CREATE FUNCTION public.nearby_audio(p_id uuid)
RETURNS TABLE (mime text, audio_b64 text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  SELECT a.mime, encode(a.audio, 'base64')
  FROM public.nearby_messages m JOIN private.nearby_audio a ON a.message_id = m.id
  WHERE m.id = p_id AND uid IN (m.sender_id, m.recipient_id) AND m.created_at > now() - interval '24 hours';
END $$;

-- The last 24 h with one person, newest first.
CREATE FUNCTION public.nearby_history(p_other uuid, p_limit int DEFAULT 20)
RETURNS TABLE (id uuid, sender_id uuid, duration_ms int, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  SELECT m.id, m.sender_id, m.duration_ms, m.created_at
  FROM public.nearby_messages m
  WHERE least(m.sender_id, m.recipient_id) = least(uid, p_other)
    AND greatest(m.sender_id, m.recipient_id) = greatest(uid, p_other)
    AND m.created_at > now() - interval '24 hours'
    AND NOT private.is_blocked(uid, p_other)
  ORDER BY m.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100);
END $$;

-- A saved transmission leaves a 'nearby' notice (one per person, moved to the top by the next one).
CREATE FUNCTION private.notify_nearby()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.notify(NEW.recipient_id, NEW.sender_id, 'nearby');
  RETURN NEW;
END $$;
CREATE TRIGGER nearby_messages_notify AFTER INSERT ON public.nearby_messages
  FOR EACH ROW EXECUTE FUNCTION private.notify_nearby();

-- 24 h for transmissions, 1 h for knocks (the "30 people an hour" count).
CREATE FUNCTION private.expire_nearby()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM public.nearby_messages WHERE created_at < now() - interval '24 hours';
  DELETE FROM private.nearby_knocks WHERE created_at < now() - interval '1 hour';
$$;

-- ---------------------------------------------------------------------------
-- 8. Walkie-talkie between friends (mutual follows), any distance
--   Live: hold to talk → the voice goes out in ~0.25 s pieces over a private Supabase Realtime channel
--   `walkie:<a>:<b>` (a < b) and plays on the friend's phone while you speak. Presence on the same channel says who
--   is there. Only the two friends may join or send (policies on realtime.messages).
--   Kept: each transmission is also saved (≤ 60 s) and can be replayed for 24 h, then deleted (hourly job).
--   walkie_contacts: per friend, whether the channel stays open while you use the rest of the app ("channel on",
--   at most 10) and when you last looked at it (unheard counts). A saved transmission leaves a 'walkie' notice.
-- ---------------------------------------------------------------------------
CREATE TABLE public.walkie_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  duration_ms int NOT NULL CHECK (duration_ms BETWEEN 300 AND 60000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX walkie_messages_pair ON public.walkie_messages
  (least(sender_id, recipient_id), greatest(sender_id, recipient_id), created_at DESC);
CREATE INDEX walkie_messages_recent ON public.walkie_messages (created_at);

CREATE TABLE private.walkie_audio (
  message_id uuid PRIMARY KEY REFERENCES public.walkie_messages (id) ON DELETE CASCADE,
  mime text NOT NULL,
  audio bytea NOT NULL
);
ALTER TABLE private.walkie_audio ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.walkie_contacts (
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  peer_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  channel_on boolean NOT NULL DEFAULT false,
  seen_at timestamptz,
  PRIMARY KEY (user_id, peer_id),
  CHECK (user_id <> peer_id)
);

-- The channel of two friends: 'walkie:<smaller id>:<larger id>'.
CREATE FUNCTION private.walkie_topic(a uuid, b uuid)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 'walkie:' || least(a, b)::text || ':' || greatest(a, b)::text
$$;

-- May the signed-in user join / send on this Realtime topic? Only its two friends, only in canonical form.
CREATE FUNCTION private.walkie_topic_ok(p_topic text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := auth.uid();
  m text[];
  a uuid;
  b uuid;
BEGIN
  m := regexp_match(coalesce(p_topic, ''),
    '^walkie:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  IF m IS NULL OR uid IS NULL THEN RETURN false; END IF;
  a := m[1]::uuid;
  b := m[2]::uuid;
  RETURN a < b AND uid IN (a, b) AND private.are_friends(a, b) AND NOT private.is_blocked(a, b)
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id IN (a, b) AND p.disabled);
END $$;

-- Save a transmission (sent live already) so it can be replayed for 24 h. Audio base64, ≤ 1.5 MB.
CREATE FUNCTION public.send_walkie(p_to uuid, p_audio_b64 text, p_mime text, p_duration_ms int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  bytes bytea;
  mid uuid;
BEGIN
  IF NOT private.are_friends(uid, p_to) OR private.is_blocked(uid, p_to)
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_to AND NOT disabled) THEN
    RAISE EXCEPTION 'not_friends' USING ERRCODE = '42501';
  END IF;
  IF p_audio_b64 IS NULL OR char_length(p_audio_b64) > 2100000 THEN
    RAISE EXCEPTION 'audio_too_large' USING ERRCODE = '22023';
  END IF;
  bytes := decode(p_audio_b64, 'base64');
  IF octet_length(bytes) < 100 OR octet_length(bytes) > 1572864 THEN
    RAISE EXCEPTION 'audio_too_large' USING ERRCODE = '22023';
  END IF;
  PERFORM private.rate_limit('walkie', 60, interval '1 minute');
  PERFORM private.rate_limit('walkie_day', 2000, interval '1 day');
  INSERT INTO public.walkie_messages (sender_id, recipient_id, duration_ms)
  VALUES (uid, p_to, least(greatest(coalesce(p_duration_ms, 300), 300), 60000)) RETURNING id INTO mid;
  INSERT INTO private.walkie_audio (message_id, mime, audio) VALUES (mid, private.normalize_audio_mime(p_mime), bytes);
  RETURN mid;
END $$;

-- Replay one saved transmission (either of the two, within 24 h).
CREATE FUNCTION public.walkie_audio(p_id uuid)
RETURNS TABLE (mime text, audio_b64 text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  SELECT a.mime, encode(a.audio, 'base64')
  FROM public.walkie_messages m JOIN private.walkie_audio a ON a.message_id = m.id
  WHERE m.id = p_id AND uid IN (m.sender_id, m.recipient_id) AND m.created_at > now() - interval '24 hours';
END $$;

-- The last 24 h with one friend, newest first.
CREATE FUNCTION public.walkie_history(p_other uuid, p_limit int DEFAULT 50)
RETURNS TABLE (id uuid, sender_id uuid, duration_ms int, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  SELECT m.id, m.sender_id, m.duration_ms, m.created_at
  FROM public.walkie_messages m
  WHERE least(m.sender_id, m.recipient_id) = least(uid, p_other)
    AND greatest(m.sender_id, m.recipient_id) = greatest(uid, p_other)
    AND m.created_at > now() - interval '24 hours'
    AND NOT private.is_blocked(uid, p_other)
  ORDER BY m.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END $$;

CREATE FUNCTION private.notify_walkie()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.notify(NEW.recipient_id, NEW.sender_id, 'walkie');
  RETURN NEW;
END $$;
CREATE TRIGGER walkie_messages_notify AFTER INSERT ON public.walkie_messages
  FOR EACH ROW EXECUTE FUNCTION private.notify_walkie();

-- Your friends (mutual follows, not blocked, not disabled) for the walkie screen: channel on, last transmission
-- between you in the last 24 h, and how many of theirs came after you last opened their walkie.
CREATE FUNCTION public.walkie_list()
RETURNS TABLE (user_id uuid, username text, full_name text, avatar_path text, channel_on boolean,
               last_at timestamptz, unheard int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  SELECT p.id, p.username, p.full_name, p.avatar_path, coalesce(c.channel_on, false),
         (SELECT max(m.created_at) FROM public.walkie_messages m
          WHERE ((m.sender_id = uid AND m.recipient_id = p.id) OR (m.sender_id = p.id AND m.recipient_id = uid))
            AND m.created_at > now() - interval '24 hours'),
         (SELECT count(*)::int FROM public.walkie_messages m
          WHERE m.sender_id = p.id AND m.recipient_id = uid AND m.created_at > now() - interval '24 hours'
            AND m.created_at > coalesce(c.seen_at, '-infinity'::timestamptz))
  FROM public.follows f
  JOIN public.follows back ON back.follower_id = f.followee_id AND back.followee_id = uid
  JOIN public.profiles p ON p.id = f.followee_id
  LEFT JOIN public.walkie_contacts c ON c.user_id = uid AND c.peer_id = p.id
  WHERE f.follower_id = uid AND NOT p.disabled AND NOT private.is_blocked(uid, p.id)
  ORDER BY 6 DESC NULLS LAST, 5 DESC, lower(coalesce(nullif(p.full_name, ''), p.username));
END $$;

-- Keep a friend's channel open while you use the app (at most 10 open at once).
CREATE FUNCTION public.walkie_set_channel(p_peer uuid, p_on boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF coalesce(p_on, false) THEN
    IF NOT private.are_friends(uid, p_peer) OR private.is_blocked(uid, p_peer) THEN
      RAISE EXCEPTION 'not_friends' USING ERRCODE = '42501';
    END IF;
    IF (SELECT count(*) FROM public.walkie_contacts WHERE user_id = uid AND channel_on AND peer_id <> p_peer) >= 10 THEN
      RAISE EXCEPTION 'too_many_channels' USING ERRCODE = '22023';
    END IF;
  END IF;
  INSERT INTO public.walkie_contacts (user_id, peer_id, channel_on) VALUES (uid, p_peer, coalesce(p_on, false))
  ON CONFLICT (user_id, peer_id) DO UPDATE SET channel_on = EXCLUDED.channel_on;
END $$;

-- You looked at a friend's walkie: their transmissions so far are heard, their walkie notice is read.
CREATE FUNCTION public.walkie_seen(p_peer uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF uid IS NULL OR p_peer IS NULL OR uid = p_peer THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_peer) THEN RETURN; END IF;
  INSERT INTO public.walkie_contacts (user_id, peer_id, seen_at) VALUES (uid, p_peer, now())
  ON CONFLICT (user_id, peer_id) DO UPDATE SET seen_at = now();
  UPDATE public.notifications SET read_at = now()
  WHERE user_id = uid AND actor_id = p_peer AND kind = 'walkie' AND read_at IS NULL;
END $$;

CREATE FUNCTION private.expire_walkie()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM public.walkie_messages WHERE created_at < now() - interval '24 hours';
$$;

-- Live-audio diagnostics: technical counters only (pieces sent / received / played, audio context state, device),
-- never audio. The app reports anomalies only. Read with the service role; kept 3 days.
CREATE TABLE private.walkie_diag (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);
CREATE INDEX walkie_diag_at ON private.walkie_diag (at);
ALTER TABLE private.walkie_diag ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.walkie_diag(p_data jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF length(p_data::text) > 4000 THEN RETURN; END IF;
  IF (SELECT count(*) FROM private.walkie_diag WHERE user_id = uid AND at > now() - interval '1 hour') >= 200 THEN RETURN; END IF;
  INSERT INTO private.walkie_diag (user_id, data) VALUES (uid, p_data);
END $$;

CREATE FUNCTION private.expire_misc()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM private.walkie_diag WHERE at < now() - interval '3 days';
  DELETE FROM private.rate_events WHERE at < now() - interval '2 days';
$$;

-- ---------------------------------------------------------------------------
-- 9. Blocks: hide both ways everywhere (map, talk, lists) and wipe what the pair shared
-- ---------------------------------------------------------------------------
CREATE FUNCTION private.on_block()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.follows
  WHERE (follower_id = NEW.blocker_id AND followee_id = NEW.blocked_id)
     OR (follower_id = NEW.blocked_id AND followee_id = NEW.blocker_id);
  DELETE FROM public.notifications
  WHERE (user_id = NEW.blocker_id AND actor_id = NEW.blocked_id)
     OR (user_id = NEW.blocked_id AND actor_id = NEW.blocker_id);
  DELETE FROM public.walkie_messages
  WHERE (sender_id = NEW.blocker_id AND recipient_id = NEW.blocked_id)
     OR (sender_id = NEW.blocked_id AND recipient_id = NEW.blocker_id);
  DELETE FROM public.walkie_contacts
  WHERE (user_id = NEW.blocker_id AND peer_id = NEW.blocked_id)
     OR (user_id = NEW.blocked_id AND peer_id = NEW.blocker_id);
  DELETE FROM public.nearby_messages
  WHERE (sender_id = NEW.blocker_id AND recipient_id = NEW.blocked_id)
     OR (sender_id = NEW.blocked_id AND recipient_id = NEW.blocker_id);
  DELETE FROM private.nearby_knocks
  WHERE (sender_id = NEW.blocker_id AND recipient_id = NEW.blocked_id)
     OR (sender_id = NEW.blocked_id AND recipient_id = NEW.blocker_id);
  RETURN NEW;
END $$;
CREATE TRIGGER blocks_on_block AFTER INSERT ON public.blocks FOR EACH ROW EXECUTE FUNCTION private.on_block();

-- ---------------------------------------------------------------------------
-- 10. Row level security (clients read; writes only through the RPCs)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_sharing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nearby_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.walkie_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.walkie_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR (NOT disabled AND NOT private.is_blocked(auth.uid(), id)));
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND (avatar_path IS NULL OR avatar_path LIKE auth.uid()::text || '/%'));

CREATE POLICY follows_select ON public.follows FOR SELECT TO authenticated
  USING (NOT private.is_blocked(auth.uid(), follower_id) AND NOT private.is_blocked(auth.uid(), followee_id));

CREATE POLICY blocks_select_own ON public.blocks FOR SELECT TO authenticated
  USING (blocker_id = auth.uid());

CREATE POLICY notifications_select_own ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY notifications_update_own ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- reports: no client policies (insert through report_content(), read by admins through RPCs).

CREATE POLICY location_sharing_own ON public.location_sharing FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY nearby_messages_select ON public.nearby_messages FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());
CREATE POLICY walkie_messages_select ON public.walkie_messages FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());
CREATE POLICY walkie_contacts_select ON public.walkie_contacts FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Realtime authorization for private channels: receiving (SELECT) and sending (INSERT), broadcast and presence.
CREATE POLICY walkie_read ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() LIKE 'walkie:%' AND private.walkie_topic_ok(realtime.topic()));
CREATE POLICY walkie_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() LIKE 'walkie:%' AND private.walkie_topic_ok(realtime.topic()));
CREATE POLICY nearby_read ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() LIKE 'nearby:%' AND private.nearby_topic_ok(realtime.topic()));
CREATE POLICY nearby_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() LIKE 'nearby:%' AND private.nearby_topic_ok(realtime.topic()));
-- Your map inbox: only you listen; nobody writes (knocks come from nearby_knock through realtime.send).
CREATE POLICY nearby_inbox_read ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() = 'nearby-in:' || auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 11. Social RPCs
-- ---------------------------------------------------------------------------
-- Is the caller an admin? (shows the moderation tools; answers only about the caller)
CREATE FUNCTION public.am_i_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_admin(auth.uid())
$$;

CREATE FUNCTION public.follow_user(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_user IS NULL OR p_user = uid
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND NOT disabled)
     OR private.is_blocked(uid, p_user) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF private.follows(uid, p_user) THEN RETURN; END IF;
  PERFORM private.rate_limit('follow', 200, interval '1 hour');
  INSERT INTO public.follows (follower_id, followee_id) VALUES (uid, p_user) ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION public.unfollow_user(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  DELETE FROM public.follows WHERE follower_id = uid AND followee_id = p_user;
END $$;

CREATE FUNCTION public.remove_follower(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  DELETE FROM public.follows WHERE follower_id = p_user AND followee_id = uid;
END $$;

-- Public profile card: counts and the relation to the caller (nothing across a block).
CREATE FUNCTION public.profile_stats(p_user uuid)
RETURNS TABLE (followers int, following int, i_follow boolean, follows_me boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF private.is_blocked(uid, p_user) THEN RETURN; END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::int FROM public.follows f JOIN public.profiles p ON p.id = f.follower_id
     WHERE f.followee_id = p_user AND NOT p.disabled),
    (SELECT count(*)::int FROM public.follows f JOIN public.profiles p ON p.id = f.followee_id
     WHERE f.follower_id = p_user AND NOT p.disabled),
    private.follows(uid, p_user),
    private.follows(p_user, uid);
END $$;

-- Search by username or name (Greek or Latin), blocked and disabled people left out.
CREATE FUNCTION public.search_users(p_query text)
RETURNS TABLE (id uuid, username text, full_name text, avatar_path text, i_follow boolean, follows_me boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  q text := private.slugify(p_query);
  flat text := translate(private.slugify(p_query), '._', '');
BEGIN
  IF char_length(q) < 2 THEN RETURN; END IF;
  RETURN QUERY
  SELECT p.id, p.username, p.full_name, p.avatar_path, private.follows(uid, p.id), private.follows(p.id, uid)
  FROM public.profiles p
  WHERE p.id <> uid AND NOT p.disabled AND NOT private.is_blocked(uid, p.id)
    AND (starts_with(p.username, q)
         OR starts_with(translate(p.username, '._', ''), flat)
         OR starts_with(translate(private.slugify(p.full_name), '._', ''), flat)
         OR position('.' || q IN private.slugify(p.full_name)) > 0)
  ORDER BY (p.username = q) DESC, private.follows(uid, p.id) DESC, p.username
  LIMIT 20;
END $$;

-- Followers or following of a user (blocked and disabled people left out), paged.
CREATE FUNCTION public.follow_list(p_user uuid, p_which text, p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS TABLE (id uuid, username text, full_name text, avatar_path text, i_follow boolean, follows_me boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_which NOT IN ('followers', 'following') OR private.is_blocked(uid, p_user) THEN RETURN; END IF;
  RETURN QUERY
  SELECT p.id, p.username, p.full_name, p.avatar_path, private.follows(uid, p.id), private.follows(p.id, uid)
  FROM public.follows f
  JOIN public.profiles p ON p.id = CASE WHEN p_which = 'followers' THEN f.follower_id ELSE f.followee_id END
  WHERE (CASE WHEN p_which = 'followers' THEN f.followee_id ELSE f.follower_id END) = p_user
    AND NOT p.disabled AND NOT private.is_blocked(uid, p.id)
  ORDER BY f.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 100) OFFSET greatest(coalesce(p_offset, 0), 0);
END $$;

-- People to follow: followed by people you follow first, then the most followed.
CREATE FUNCTION public.suggested_people(p_limit int DEFAULT 10)
RETURNS TABLE (id uuid, username text, full_name text, avatar_path text, i_follow boolean, follows_me boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  SELECT p.id, p.username, p.full_name, p.avatar_path, false, private.follows(p.id, uid)
  FROM public.profiles p
  WHERE p.id <> uid AND NOT p.disabled AND NOT private.is_blocked(uid, p.id) AND NOT private.follows(uid, p.id)
  ORDER BY
    (SELECT count(*) FROM public.follows f1 JOIN public.follows f2 ON f2.follower_id = f1.followee_id
     WHERE f1.follower_id = uid AND f2.followee_id = p.id) DESC,
    (SELECT count(*) FROM public.follows f WHERE f.followee_id = p.id) DESC,
    p.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 10), 1), 30);
END $$;

-- Block: ends follows both ways, wipes what you said to each other (trigger), hides both sides everywhere.
CREATE FUNCTION public.block_user(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_user IS NULL OR p_user = uid OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.blocks (blocker_id, blocked_id) VALUES (uid, p_user) ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION public.unblock_user(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  DELETE FROM public.blocks WHERE blocker_id = uid AND blocked_id = p_user;
END $$;

-- Blocked accounts (for Settings → Blocked).
CREATE FUNCTION public.my_blocked()
RETURNS TABLE (id uuid, username text, full_name text, avatar_path text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  SELECT p.id, p.username, p.full_name, p.avatar_path
  FROM public.blocks b JOIN public.profiles p ON p.id = b.blocked_id
  WHERE b.blocker_id = uid ORDER BY b.created_at DESC;
END $$;

-- Report a user, or one of their saved transmissions to you (walkie / nearby). Also allowed across a block, so you
-- can block first and report after.
CREATE FUNCTION public.report_content(p_kind text, p_target uuid, p_reason text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  target_user uuid;
BEGIN
  IF p_kind = 'user' THEN
    SELECT id INTO target_user FROM public.profiles WHERE id = p_target;
  ELSIF p_kind = 'walkie' THEN
    SELECT m.sender_id INTO target_user FROM public.walkie_messages m WHERE m.id = p_target AND m.recipient_id = uid;
  ELSIF p_kind = 'nearby' THEN
    SELECT m.sender_id INTO target_user FROM public.nearby_messages m WHERE m.id = p_target AND m.recipient_id = uid;
  END IF;
  IF target_user IS NULL OR target_user = uid THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM private.rate_limit('report', 20, interval '1 hour');
  INSERT INTO public.reports (reporter_id, target_user_id, kind, target_id, reason)
  VALUES (uid, target_user, p_kind, CASE WHEN p_kind = 'user' THEN NULL ELSE p_target END, left(coalesce(p_reason, ''), 500));
END $$;

-- ---------------------------------------------------------------------------
-- 12. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON public.profiles, public.follows, public.blocks, public.notifications, public.location_sharing,
  public.nearby_messages, public.walkie_messages, public.walkie_contacts TO authenticated;
GRANT UPDATE (username, full_name, bio, avatar_path) ON public.profiles TO authenticated;
GRANT UPDATE (read_at) ON public.notifications TO authenticated;

REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA private TO service_role;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
-- Private helpers: nothing for clients, except what RLS policies (evaluated as the caller) call directly.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_blocked(uuid, uuid), private.walkie_topic_ok(text), private.nearby_topic_ok(text)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 13. Storage: public `avatars` bucket (served by URL, not listable), uploads into your own folder
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY avatars_upload_own ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY avatars_delete_own ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 14. Realtime (postgres_changes respect RLS): the bell
-- ---------------------------------------------------------------------------
DO $realtime$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
EXCEPTION WHEN undefined_object OR insufficient_privilege OR duplicate_object THEN
  RAISE NOTICE 'realtime publication not updated: %', SQLERRM;
END
$realtime$;

-- ---------------------------------------------------------------------------
-- 15. Scheduled jobs (pg_cron; skipped where the extension is unavailable, e.g. the local test database)
-- ---------------------------------------------------------------------------
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule('expire-locations', '*/10 * * * *', 'SELECT private.expire_locations()');
    PERFORM cron.schedule('expire-nearby', '39 * * * *', 'SELECT private.expire_nearby()');
    PERFORM cron.schedule('expire-walkie', '37 * * * *', 'SELECT private.expire_walkie()');
    PERFORM cron.schedule('expire-misc', '41 3 * * *', 'SELECT private.expire_misc()');
  ELSE
    RAISE NOTICE 'pg_cron not available: run the private.expire_* jobs another way';
  END IF;
EXCEPTION WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
  RAISE NOTICE 'pg_cron not set up: %', SQLERRM;
END
$cron$;
