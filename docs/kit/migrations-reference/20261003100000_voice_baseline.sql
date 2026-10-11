-- Voice-only social network: fresh baseline.
-- Drops the old court-booking / Instagram-style schema (when present) and creates the new one.
-- auth.users (accounts) is kept; a profile is created for every existing account.
--
-- Rules of thumb:
--  * RLS on every table; clients only SELECT (plus a few column-level UPDATE/DELETE grants).
--  * Every write goes through a SECURITY DEFINER RPC in `public` that checks auth.uid().
--  * Helpers live in `private` (not exposed by the API; usable inside RLS policies).
--  * One "moment" per day: the day's prompt fires at the same pseudo-random time for everyone
--    (Europe/Athens, 10:00–21:00). A moment lasts until the next prompt.

-- ---------------------------------------------------------------------------
-- 1. Legacy cleanup (no-op on an empty database)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

DO $legacy$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.viewname);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('DROP ROUTINE IF EXISTS %s CASCADE', r.sig);
  END LOOP;
  FOR r IN
    SELECT t.typname FROM pg_type t
    WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
  END LOOP;
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
  END LOOP;
END
$legacy$;

DROP SCHEMA IF EXISTS private CASCADE;
DROP EXTENSION IF EXISTS btree_gist;

-- Old buckets `venue-photos` / `social-media` are removed through the Storage API
-- (Supabase blocks deleting storage rows from SQL); they have no policies any more.

-- ---------------------------------------------------------------------------
-- 2. Private schema: helpers, rate limits
-- ---------------------------------------------------------------------------
CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
-- Needed so RLS policies (evaluated as the caller) can use the helpers below.
-- The schema is not exposed by the Data API, so nothing here is callable over HTTP.
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE TABLE private.rate_events (
  user_id uuid NOT NULL,
  action text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_events_lookup ON private.rate_events (user_id, action, at);
ALTER TABLE private.rate_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.rate_events FROM PUBLIC, anon, authenticated;

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

-- The day's prompt time: same for everyone, pseudo-random between 10:00 and 20:59 Athens time.
CREATE FUNCTION private.prompt_at(d date)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT ((d + time '10:00')
          + make_interval(mins => (('x' || substr(md5('courtsie-prompt-' || d::text), 1, 8))::bit(32)::bigint % 660)::int))
         AT TIME ZONE 'Europe/Athens'
$$;

-- The current moment = date of the latest prompt that has already fired.
CREATE FUNCTION private.current_moment()
RETURNS date LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE WHEN now() >= private.prompt_at(x.t) THEN x.t ELSE x.t - 1 END
  FROM (SELECT (now() AT TIME ZONE 'Europe/Athens')::date AS t) x
$$;

-- ---------------------------------------------------------------------------
-- 3. Profiles
-- ---------------------------------------------------------------------------
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._]{3,20}$'),
  full_name text NOT NULL DEFAULT '' CHECK (char_length(full_name) <= 60),
  avatar_path text CHECK (avatar_path IS NULL OR char_length(avatar_path) <= 200),
  disabled boolean NOT NULL DEFAULT false,
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
  INSERT INTO public.profiles (id, username, full_name)
  VALUES (p_id, candidate, left(coalesce(p_meta ->> 'full_name', ''), 60))
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

DO $backfill$
DECLARE u record;
BEGIN
  FOR u IN SELECT id, email, raw_user_meta_data FROM auth.users ORDER BY created_at LOOP
    PERFORM private.create_profile(u.id, u.email, coalesce(u.raw_user_meta_data, '{}'::jsonb));
  END LOOP;
END
$backfill$;

-- ---------------------------------------------------------------------------
-- 4. Friendships and blocks
-- ---------------------------------------------------------------------------
CREATE TABLE public.friendships (
  user_a uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  user_b uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b),
  CHECK (requested_by IN (user_a, user_b))
);
CREATE INDEX friendships_user_b ON public.friendships (user_b);

CREATE TABLE public.blocks (
  blocker_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked ON public.blocks (blocked_id);

CREATE FUNCTION private.are_friends(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.friendships
    WHERE user_a = least(a, b) AND user_b = greatest(a, b) AND status = 'accepted')
$$;

CREATE FUNCTION private.is_blocked(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocks
    WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id = b AND blocked_id = a))
$$;

-- Raises unless the caller is signed in and not disabled.
CREATE FUNCTION private.me()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = uid AND NOT disabled) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  RETURN uid;
END $$;

-- ---------------------------------------------------------------------------
-- 5. In-app notifications (the bell)
-- ---------------------------------------------------------------------------
CREATE TABLE public.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('friend_request', 'friend_accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_user ON public.notifications (user_id, created_at DESC);

CREATE FUNCTION private.notify(p_user uuid, p_actor uuid, p_kind text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM public.notifications WHERE user_id = p_user AND actor_id = p_actor AND kind = p_kind;
  INSERT INTO public.notifications (user_id, actor_id, kind) VALUES (p_user, p_actor, p_kind);
$$;

-- ---------------------------------------------------------------------------
-- 6. Voice DMs (listen-once). Audio bytes live in a private table and are deleted
--    in the same transaction that marks the message opened.
-- ---------------------------------------------------------------------------
CREATE TABLE public.voice_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  duration_ms int NOT NULL CHECK (duration_ms BETWEEN 300 AND 60000),
  created_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz,
  expired_at timestamptz,
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX voice_messages_recipient ON public.voice_messages (recipient_id, created_at DESC);
CREATE INDEX voice_messages_sender ON public.voice_messages (sender_id, created_at DESC);
CREATE INDEX voice_messages_pending ON public.voice_messages (created_at) WHERE opened_at IS NULL AND expired_at IS NULL;

CREATE TABLE private.voice_message_audio (
  message_id uuid PRIMARY KEY REFERENCES public.voice_messages (id) ON DELETE CASCADE,
  mime text NOT NULL,
  audio bytea NOT NULL
);
ALTER TABLE private.voice_message_audio ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.voice_message_audio FROM PUBLIC, anon, authenticated;

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
-- 7. Daily voice posts (files in the private `daily-posts` bucket: <uid>/<name>)
-- ---------------------------------------------------------------------------
CREATE TABLE public.daily_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  moment date NOT NULL,
  audio_path text NOT NULL UNIQUE,
  mime text NOT NULL,
  duration_ms int NOT NULL CHECK (duration_ms BETWEEN 1000 AND 90000),
  late boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, moment)
);
CREATE INDEX daily_posts_recent ON public.daily_posts (created_at DESC);

CREATE FUNCTION private.has_posted_current(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.daily_posts WHERE user_id = p_user AND moment = private.current_moment())
$$;

-- Can the caller play this daily-post file? Own files always; a friend's file only while the
-- post is < 24 h old and the caller has posted in the current moment (the unlock rule).
CREATE FUNCTION private.can_listen_post(p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.daily_posts p
    WHERE p.audio_path = p_path
      AND (p.user_id = auth.uid()
           OR (p.created_at > now() - interval '24 hours'
               AND private.are_friends(auth.uid(), p.user_id)
               AND NOT private.is_blocked(auth.uid(), p.user_id)
               AND private.has_posted_current(auth.uid()))))
$$;

-- ---------------------------------------------------------------------------
-- 8. Reports (UGC moderation; reviewed in the Supabase dashboard)
-- ---------------------------------------------------------------------------
CREATE TABLE public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  target_user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('user', 'daily_post', 'voice_message')),
  target_id uuid,
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX reports_open ON public.reports (created_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- 9. Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR (NOT disabled AND NOT private.is_blocked(auth.uid(), id)));
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND (avatar_path IS NULL OR avatar_path LIKE auth.uid()::text || '/%'));

CREATE POLICY friendships_select_own ON public.friendships FOR SELECT TO authenticated
  USING (auth.uid() IN (user_a, user_b));

CREATE POLICY blocks_select_own ON public.blocks FOR SELECT TO authenticated
  USING (blocker_id = auth.uid());

CREATE POLICY notifications_select_own ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY notifications_update_own ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY voice_messages_select_own ON public.voice_messages FOR SELECT TO authenticated
  USING (auth.uid() IN (sender_id, recipient_id));

CREATE POLICY daily_posts_select ON public.daily_posts FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR (created_at > now() - interval '24 hours'
             AND private.are_friends(auth.uid(), user_id)
             AND NOT private.is_blocked(auth.uid(), user_id)));
CREATE POLICY daily_posts_delete_own ON public.daily_posts FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- reports: no client policies (insert through report_content()).

-- ---------------------------------------------------------------------------
-- 10. RPCs (the only write path for clients)
-- ---------------------------------------------------------------------------

-- Username search (prefix), with the relation to the caller.
CREATE FUNCTION public.search_users(p_query text)
RETURNS TABLE (id uuid, username text, full_name text, avatar_path text, relation text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  q text := private.slugify(p_query);
BEGIN
  IF char_length(q) < 2 THEN RETURN; END IF;
  RETURN QUERY
  SELECT p.id, p.username, p.full_name, p.avatar_path,
         CASE WHEN f.status = 'accepted' THEN 'friends'
              WHEN f.status = 'pending' AND f.requested_by = uid THEN 'outgoing'
              WHEN f.status = 'pending' THEN 'incoming'
              ELSE 'none' END
  FROM public.profiles p
  LEFT JOIN public.friendships f ON f.user_a = least(uid, p.id) AND f.user_b = greatest(uid, p.id)
  WHERE starts_with(p.username, q) AND p.id <> uid AND NOT p.disabled
    AND NOT private.is_blocked(uid, p.id)
  ORDER BY (p.username = q) DESC, p.username
  LIMIT 20;
END $$;

-- Friends plus pending requests in both directions.
CREATE FUNCTION public.my_friends()
RETURNS TABLE (id uuid, username text, full_name text, avatar_path text, relation text, since timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  SELECT p.id, p.username, p.full_name, p.avatar_path,
         CASE WHEN f.status = 'accepted' THEN 'friends'
              WHEN f.requested_by = uid THEN 'outgoing' ELSE 'incoming' END,
         coalesce(f.accepted_at, f.created_at)
  FROM public.friendships f
  JOIN public.profiles p ON p.id = CASE WHEN f.user_a = uid THEN f.user_b ELSE f.user_a END
  WHERE uid IN (f.user_a, f.user_b) AND NOT p.disabled
  ORDER BY (f.status = 'pending' AND f.requested_by <> uid) DESC, p.username;
END $$;

-- Send a request, or accept theirs if they already asked. Returns the new relation.
CREATE FUNCTION public.send_friend_request(p_user uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  f public.friendships;
BEGIN
  IF p_user IS NULL OR p_user = uid
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND NOT disabled)
     OR private.is_blocked(uid, p_user) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO f FROM public.friendships
  WHERE user_a = least(uid, p_user) AND user_b = greatest(uid, p_user) FOR UPDATE;
  IF FOUND THEN
    IF f.status = 'accepted' THEN RETURN 'friends'; END IF;
    IF f.requested_by = uid THEN RETURN 'outgoing'; END IF;
    UPDATE public.friendships SET status = 'accepted', accepted_at = now()
    WHERE user_a = f.user_a AND user_b = f.user_b;
    PERFORM private.notify(p_user, uid, 'friend_accepted');
    RETURN 'friends';
  END IF;
  PERFORM private.rate_limit('friend_request', 50, interval '1 hour');
  INSERT INTO public.friendships (user_a, user_b, requested_by)
  VALUES (least(uid, p_user), greatest(uid, p_user), uid);
  PERFORM private.notify(p_user, uid, 'friend_request');
  RETURN 'outgoing';
END $$;

CREATE FUNCTION public.accept_friend_request(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  UPDATE public.friendships SET status = 'accepted', accepted_at = now()
  WHERE user_a = least(uid, p_user) AND user_b = greatest(uid, p_user)
    AND status = 'pending' AND requested_by = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  DELETE FROM public.notifications WHERE user_id = uid AND actor_id = p_user AND kind = 'friend_request';
  PERFORM private.notify(p_user, uid, 'friend_accepted');
END $$;

-- Decline an incoming request, cancel an outgoing one, or unfriend.
CREATE FUNCTION public.remove_friend(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  DELETE FROM public.friendships WHERE user_a = least(uid, p_user) AND user_b = greatest(uid, p_user);
  DELETE FROM public.notifications
  WHERE kind = 'friend_request' AND ((user_id = uid AND actor_id = p_user) OR (user_id = p_user AND actor_id = uid));
END $$;

-- Block: ends the friendship, drops their unheard messages to me, hides both sides from search.
CREATE FUNCTION public.block_user(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_user IS NULL OR p_user = uid OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.blocks (blocker_id, blocked_id) VALUES (uid, p_user) ON CONFLICT DO NOTHING;
  DELETE FROM public.friendships WHERE user_a = least(uid, p_user) AND user_b = greatest(uid, p_user);
  DELETE FROM public.notifications WHERE (user_id = uid AND actor_id = p_user) OR (user_id = p_user AND actor_id = uid);
  DELETE FROM private.voice_message_audio a USING public.voice_messages m
  WHERE a.message_id = m.id AND m.sender_id = p_user AND m.recipient_id = uid;
  UPDATE public.voice_messages SET expired_at = now()
  WHERE sender_id = p_user AND recipient_id = uid AND opened_at IS NULL AND expired_at IS NULL;
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

-- Send a recorded voice message to a friend. Audio comes base64-encoded (max 1 MB decoded).
CREATE FUNCTION public.send_voice_message(p_to uuid, p_audio_b64 text, p_mime text, p_duration_ms int)
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
  IF p_audio_b64 IS NULL OR char_length(p_audio_b64) > 1400000 THEN
    RAISE EXCEPTION 'audio_too_large' USING ERRCODE = '22023';
  END IF;
  bytes := decode(p_audio_b64, 'base64');
  IF octet_length(bytes) < 100 OR octet_length(bytes) > 1048576 THEN
    RAISE EXCEPTION 'audio_too_large' USING ERRCODE = '22023';
  END IF;
  PERFORM private.rate_limit('voice_message', 30, interval '1 minute');
  PERFORM private.rate_limit('voice_message_day', 500, interval '1 day');
  INSERT INTO public.voice_messages (sender_id, recipient_id, duration_ms)
  VALUES (uid, p_to, p_duration_ms) RETURNING id INTO mid;
  INSERT INTO private.voice_message_audio (message_id, mime, audio)
  VALUES (mid, private.normalize_audio_mime(p_mime), bytes);
  RETURN mid;
END $$;

-- Listen once: returns the audio and deletes it in the same transaction.
CREATE FUNCTION public.consume_voice_message(p_id uuid)
RETURNS TABLE (mime text, audio_b64 text, duration_ms int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  v_dur int;
  v_sender uuid;
BEGIN
  UPDATE public.voice_messages m SET opened_at = now()
  WHERE m.id = p_id AND m.recipient_id = uid AND m.opened_at IS NULL AND m.expired_at IS NULL
  RETURNING m.duration_ms, m.sender_id INTO v_dur, v_sender;
  IF NOT FOUND OR private.is_blocked(uid, v_sender) THEN
    RAISE EXCEPTION 'not_available' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  DELETE FROM private.voice_message_audio a WHERE a.message_id = p_id
  RETURNING a.mime, translate(encode(a.audio, 'base64'), E'\n', ''), v_dur;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_available' USING ERRCODE = 'P0002'; END IF;
END $$;

-- Inbox: one row per person I have messages with.
CREATE FUNCTION public.my_threads()
RETURNS TABLE (other_id uuid, username text, full_name text, avatar_path text,
               last_at timestamptz, last_from_me boolean, last_state text, unheard int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  WITH mine AS (
    SELECT m.*, CASE WHEN m.sender_id = uid THEN m.recipient_id ELSE m.sender_id END AS other
    FROM public.voice_messages m WHERE uid IN (m.sender_id, m.recipient_id)
  ), latest AS (
    SELECT DISTINCT ON (other) other, created_at, sender_id = uid AS from_me,
           CASE WHEN opened_at IS NOT NULL THEN 'opened' WHEN expired_at IS NOT NULL THEN 'expired' ELSE 'delivered' END AS state
    FROM mine ORDER BY other, created_at DESC
  )
  SELECT p.id, p.username, p.full_name, p.avatar_path, l.created_at, l.from_me, l.state,
         (SELECT count(*)::int FROM mine x
          WHERE x.other = l.other AND x.recipient_id = uid AND x.opened_at IS NULL AND x.expired_at IS NULL)
  FROM latest l JOIN public.profiles p ON p.id = l.other
  WHERE NOT private.is_blocked(uid, l.other)
  ORDER BY l.created_at DESC;
END $$;

-- Today's state: the moment, its prompt time, the next prompt, my post, unlock status.
CREATE FUNCTION public.today()
RETURNS TABLE (moment date, prompt_at timestamptz, next_prompt_at timestamptz,
               my_post_id uuid, unlocked boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  m date := private.current_moment();
  pid uuid;
BEGIN
  SELECT d.id INTO pid FROM public.daily_posts d WHERE d.user_id = uid AND d.moment = m;
  RETURN QUERY SELECT m, private.prompt_at(m), private.prompt_at(m + 1), pid, pid IS NOT NULL;
END $$;

-- Prompt times for local notifications (same for every device).
CREATE FUNCTION public.prompt_schedule(p_days int DEFAULT 30)
RETURNS TABLE (moment date, prompt_at timestamptz)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT d::date, private.prompt_at(d::date)
  FROM generate_series((now() AT TIME ZONE 'Europe/Athens')::date,
                       (now() AT TIME ZONE 'Europe/Athens')::date + (least(greatest(coalesce(p_days, 30), 1), 60) - 1),
                       interval '1 day') AS d
$$;

-- Publish the daily post after uploading its file to daily-posts/<uid>/...
CREATE FUNCTION public.publish_daily_post(p_path text, p_mime text, p_duration_ms int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  m date := private.current_moment();
  pid uuid;
BEGIN
  IF p_path IS NULL OR NOT starts_with(p_path, uid::text || '/') OR char_length(p_path) > 200
     OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'daily-posts' AND name = p_path) THEN
    RAISE EXCEPTION 'file_missing' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.daily_posts WHERE user_id = uid AND moment = m) THEN
    RAISE EXCEPTION 'already_posted' USING ERRCODE = '23505';
  END IF;
  PERFORM private.rate_limit('daily_post', 10, interval '1 day');
  INSERT INTO public.daily_posts (user_id, moment, audio_path, mime, duration_ms, late)
  VALUES (uid, m, p_path, private.normalize_audio_mime(p_mime), p_duration_ms,
          now() > private.prompt_at(m) + interval '2 minutes')
  RETURNING id INTO pid;
  RETURN pid;
END $$;

-- Friends' posts from the last 24 h (+ my current one). audio_path is null while locked.
CREATE FUNCTION public.feed()
RETURNS TABLE (post_id uuid, user_id uuid, username text, full_name text, avatar_path text,
               created_at timestamptz, duration_ms int, late boolean, audio_path text, is_mine boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  is_open boolean := private.has_posted_current(uid);
BEGIN
  RETURN QUERY
  SELECT d.id, p.id, p.username, p.full_name, p.avatar_path, d.created_at, d.duration_ms, d.late,
         CASE WHEN is_open OR d.user_id = uid THEN d.audio_path END, d.user_id = uid
  FROM public.daily_posts d JOIN public.profiles p ON p.id = d.user_id
  WHERE d.created_at > now() - interval '24 hours'
    AND NOT p.disabled
    AND ((d.user_id = uid AND d.moment = private.current_moment())
         OR (private.are_friends(uid, d.user_id) AND NOT private.is_blocked(uid, d.user_id)))
  ORDER BY d.user_id = uid DESC, d.created_at DESC;
END $$;

-- Report a user, a daily post or a voice message.
CREATE FUNCTION public.report_content(p_kind text, p_target uuid, p_reason text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  target_user uuid;
BEGIN
  IF p_kind = 'user' THEN
    SELECT id INTO target_user FROM public.profiles WHERE id = p_target;
  ELSIF p_kind = 'daily_post' THEN
    SELECT d.user_id INTO target_user FROM public.daily_posts d
    WHERE d.id = p_target AND (private.are_friends(uid, d.user_id) OR private.is_blocked(uid, d.user_id));
  ELSIF p_kind = 'voice_message' THEN
    SELECT m.sender_id INTO target_user FROM public.voice_messages m WHERE m.id = p_target AND m.recipient_id = uid;
  END IF;
  IF target_user IS NULL OR target_user = uid THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM private.rate_limit('report', 20, interval '1 hour');
  INSERT INTO public.reports (reporter_id, target_user_id, kind, target_id, reason)
  VALUES (uid, target_user, p_kind, CASE WHEN p_kind = 'user' THEN NULL ELSE p_target END, left(coalesce(p_reason, ''), 500));
END $$;

-- ---------------------------------------------------------------------------
-- 11. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON public.profiles, public.friendships, public.blocks, public.notifications,
  public.voice_messages, public.daily_posts TO authenticated;
GRANT UPDATE (username, full_name, avatar_path) ON public.profiles TO authenticated;
GRANT UPDATE (read_at) ON public.notifications TO authenticated;
GRANT DELETE ON public.daily_posts TO authenticated;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
-- Mutating helpers are only for the definer RPCs above.
REVOKE EXECUTE ON FUNCTION private.rate_limit(text, int, interval), private.create_profile(uuid, text, jsonb),
  private.handle_new_user(), private.notify(uuid, uuid, text) FROM PUBLIC, authenticated;

-- ---------------------------------------------------------------------------
-- 12. Storage buckets and policies
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('daily-posts', 'daily-posts', false, 2097152,
        ARRAY['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/webm', 'audio/ogg'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY daily_posts_upload_own ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'daily-posts' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY daily_posts_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'daily-posts'
         AND ((storage.foldername(name))[1] = auth.uid()::text OR private.can_listen_post(name)));
CREATE POLICY daily_posts_delete_own ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'daily-posts' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Avatars are public by URL but not listable (no SELECT policy).
CREATE POLICY avatars_upload_own ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY avatars_delete_own ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 13. Realtime (RLS applies to postgres_changes)
-- ---------------------------------------------------------------------------
DO $realtime$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.voice_messages, public.friendships,
    public.notifications, public.daily_posts;
EXCEPTION WHEN undefined_object OR insufficient_privilege OR duplicate_object THEN
  RAISE NOTICE 'realtime publication not updated: %', SQLERRM;
END
$realtime$;

-- ---------------------------------------------------------------------------
-- 14. Scheduled jobs (pg_cron; skipped where the extension is unavailable)
-- ---------------------------------------------------------------------------
CREATE FUNCTION private.expire_voice_messages()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  -- Unheard after 10 days: drop the audio, keep the row as "expired".
  DELETE FROM private.voice_message_audio a USING public.voice_messages m
  WHERE a.message_id = m.id AND m.opened_at IS NULL AND m.created_at < now() - interval '10 days';
  UPDATE public.voice_messages SET expired_at = now()
  WHERE opened_at IS NULL AND expired_at IS NULL AND created_at < now() - interval '10 days';
  -- History rows (no audio) are kept for 90 days.
  DELETE FROM public.voice_messages WHERE created_at < now() - interval '90 days';
  DELETE FROM private.rate_events WHERE at < now() - interval '2 days';
$$;
REVOKE EXECUTE ON FUNCTION private.expire_voice_messages() FROM PUBLIC, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule('expire-voice-messages', '7 * * * *', 'SELECT private.expire_voice_messages()');
  ELSE
    RAISE NOTICE 'pg_cron not available: run private.expire_voice_messages() another way';
  END IF;
EXCEPTION WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
  RAISE NOTICE 'pg_cron not set up: %', SQLERRM;
END
$cron$;
