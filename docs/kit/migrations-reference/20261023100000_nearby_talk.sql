-- Live map, part 3: push to talk to someone near you ("ωραίο αμάξι!" at the traffic light).
--   Knock: pressing the button first calls nearby_knock(them). The server checks that you may talk to them right now
--   (both sharing, ≤ 500 m, not blocked, their "who can talk to you" setting) and signals their phone through its
--   private inbox topic `nearby-in:<their id>` (realtime.send, server side only — nobody can write into an inbox).
--   Their app then joins the pair channel `nearby:<smaller id>:<larger id>` and hears you live (the first words wait a
--   moment on your phone until they are there).
--   Pair channel: only the two may join; allowed while they may talk (either way) or for 5 minutes after a knock
--   between them, so an answer still arrives when the light turns green and one of you drives on.
--   Replies: whoever talked to you may be answered for 5 minutes, whatever their own setting.
--   Kept: each transmission is saved for 24 h (replay, reports), like the friends' walkie, then deleted.
--   Anti-spam: 60 knocks a minute, at most 30 different people an hour.

CREATE TABLE private.nearby_knocks (
  sender_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_id, recipient_id),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX nearby_knocks_sender_time ON private.nearby_knocks (sender_id, created_at);
ALTER TABLE private.nearby_knocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.nearby_knocks FROM PUBLIC, anon, authenticated;

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
ALTER TABLE public.nearby_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nearby_messages FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.nearby_messages FROM authenticated;
CREATE POLICY nearby_messages_select ON public.nearby_messages FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

CREATE TABLE private.nearby_audio (
  message_id uuid PRIMARY KEY REFERENCES public.nearby_messages (id) ON DELETE CASCADE,
  mime text NOT NULL,
  audio bytea NOT NULL
);
ALTER TABLE private.nearby_audio ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.nearby_audio FROM PUBLIC, anon, authenticated;

-- May `a` talk to `b` from the map right now? Near each other (are_nearby: both sharing, fresh, ≤ 500 m, friends or
-- both "everyone", not blocked), nobody disabled, and b's setting lets a in.
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
GRANT EXECUTE ON FUNCTION private.nearby_topic_ok(text) TO authenticated;

CREATE POLICY nearby_read ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() LIKE 'nearby:%' AND private.nearby_topic_ok(realtime.topic()));
CREATE POLICY nearby_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() LIKE 'nearby:%' AND private.nearby_topic_ok(realtime.topic()));
-- Your inbox: only you listen; nobody writes (knocks come from nearby_knock through realtime.send).
CREATE POLICY nearby_inbox_read ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() = 'nearby-in:' || auth.uid()::text);

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
ALTER TABLE public.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('follow', 'like', 'reply', 'repost', 'report', 'group_invite', 'group_request', 'group_accepted',
                  'group_joined', 'invite_joined', 'walkie', 'nearby'));
CREATE FUNCTION private.notify_nearby()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.notify(NEW.recipient_id, NEW.sender_id, 'nearby');
  RETURN NEW;
END $$;
CREATE TRIGGER nearby_messages_notify AFTER INSERT ON public.nearby_messages
  FOR EACH ROW EXECUTE FUNCTION private.notify_nearby();

-- Blocking someone wipes what you said to each other on the map and closes the conversation.
CREATE FUNCTION private.nearby_on_block()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.nearby_messages
  WHERE (sender_id = NEW.blocker_id AND recipient_id = NEW.blocked_id)
     OR (sender_id = NEW.blocked_id AND recipient_id = NEW.blocker_id);
  DELETE FROM private.nearby_knocks
  WHERE (sender_id = NEW.blocker_id AND recipient_id = NEW.blocked_id)
     OR (sender_id = NEW.blocked_id AND recipient_id = NEW.blocker_id);
  RETURN NEW;
END $$;
CREATE TRIGGER nearby_on_block AFTER INSERT ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION private.nearby_on_block();

-- 24 h for transmissions, 1 h for knocks (the "30 people an hour" count).
CREATE FUNCTION private.expire_nearby()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM public.nearby_messages WHERE created_at < now() - interval '24 hours';
  DELETE FROM private.nearby_knocks WHERE created_at < now() - interval '1 hour';
$$;

-- The map: can_talk now also needs ≤ 500 m (friends show at any distance) and is true for 5 minutes for someone
-- who just talked to you (you may answer).
CREATE OR REPLACE FUNCTION public.map_people(p_radius_m int DEFAULT 500)
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
    SELECT l.*, s.mode, s.talk_from, private.are_friends(uid, l.user_id) AS friend,
           private.distance_m(me_loc.lat, me_loc.lng, l.lat, l.lng) AS dist
    FROM private.user_locations l
    JOIN public.location_sharing s ON s.user_id = l.user_id AND s.mode <> 'off'
    JOIN public.profiles p ON p.id = l.user_id AND NOT p.disabled
    WHERE l.user_id <> uid AND l.updated_at > now() - interval '15 minutes'
      AND NOT private.is_blocked(uid, l.user_id)
  )
  SELECT c.user_id, p.username, p.full_name, p.avatar_path, c.lat, c.lng, c.accuracy_m, c.heading, c.updated_at,
         round(c.dist)::int,
         c.friend,
         (c.dist <= 500 AND (c.talk_from = 'everyone' OR (c.talk_from = 'following' AND private.follows(c.user_id, uid))))
           OR private.knocked_recently(c.user_id, uid)
  FROM cand c JOIN public.profiles p ON p.id = c.user_id
  WHERE (c.friend AND c.mode IN ('friends', 'everyone'))
     OR (c.mode = 'everyone'
         AND c.lat BETWEEN me_loc.lat - dlat AND me_loc.lat + dlat
         AND c.lng BETWEEN me_loc.lng - dlng AND me_loc.lng + dlng
         AND c.dist <= r)
  ORDER BY 10
  LIMIT 200;
END $$;

REVOKE EXECUTE ON FUNCTION private.may_talk_nearby(uuid, uuid), private.knocked_recently(uuid, uuid),
  private.may_send_nearby(uuid, uuid), private.notify_nearby(), private.nearby_on_block(), private.expire_nearby()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nearby_knock(uuid), public.send_nearby(uuid, text, text, int), public.nearby_audio(uuid),
  public.nearby_history(uuid, int), public.map_people(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.nearby_knock(uuid), public.send_nearby(uuid, text, text, int), public.nearby_audio(uuid),
  public.nearby_history(uuid, int), public.map_people(int) TO authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('expire-nearby', '39 * * * *', 'SELECT private.expire_nearby()');
  END IF;
END
$cron$;
