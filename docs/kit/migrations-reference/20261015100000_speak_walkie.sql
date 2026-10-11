-- Walkie-talkie between friends (mutual follows), like Zello but on the free stack.
--   Live: hold to talk → the voice goes out in ~0.25 s pieces over a private Supabase Realtime channel
--   `walkie:<a>:<b>` (a < b, the two friends) and plays on the friend's phone while you speak. Presence on the same
--   channel says who is there. Only the two friends may join or send (policies on realtime.messages).
--   Kept: each transmission is also saved (≤ 60 s) and can be replayed for 24 h, then deleted (hourly job).

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
ALTER TABLE public.walkie_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.walkie_messages FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.walkie_messages FROM authenticated;
CREATE POLICY walkie_messages_select ON public.walkie_messages FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

CREATE TABLE private.walkie_audio (
  message_id uuid PRIMARY KEY REFERENCES public.walkie_messages (id) ON DELETE CASCADE,
  mime text NOT NULL,
  audio bytea NOT NULL
);
ALTER TABLE private.walkie_audio ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.walkie_audio FROM PUBLIC, anon, authenticated;

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
GRANT EXECUTE ON FUNCTION private.walkie_topic_ok(text) TO authenticated;

-- Realtime authorization for private channels: receiving (SELECT) and sending (INSERT), broadcast and presence.
CREATE POLICY walkie_read ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() LIKE 'walkie:%' AND private.walkie_topic_ok(realtime.topic()));
CREATE POLICY walkie_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() LIKE 'walkie:%' AND private.walkie_topic_ok(realtime.topic()));

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

CREATE FUNCTION private.expire_walkie()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM public.walkie_messages WHERE created_at < now() - interval '24 hours';
$$;

-- Blocking someone also wipes your walkie history with them.
CREATE FUNCTION private.walkie_on_block()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.walkie_messages
  WHERE (sender_id = NEW.blocker_id AND recipient_id = NEW.blocked_id)
     OR (sender_id = NEW.blocked_id AND recipient_id = NEW.blocker_id);
  RETURN NEW;
END $$;
CREATE TRIGGER walkie_on_block AFTER INSERT ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION private.walkie_on_block();

-- orphan_voice_files (previous migration) is for the Worker only, but every migration's blanket GRANT below gives it
-- back to `authenticated`. Make it check the caller itself: an invoker wrapper that only service_role gets past.
DROP FUNCTION public.orphan_voice_files(int);
CREATE FUNCTION private.orphan_voice_files(p_limit int)
RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.name FROM storage.objects o
  WHERE o.bucket_id = 'voices' AND o.created_at < now() - interval '1 hour'
    AND NOT EXISTS (SELECT 1 FROM public.posts p WHERE p.audio_path = o.name)
  ORDER BY o.created_at
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;
CREATE FUNCTION public.orphan_voice_files(p_limit int DEFAULT 200)
RETURNS SETOF text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF current_user <> 'service_role' THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT * FROM private.orphan_voice_files(p_limit);
END $$;

REVOKE EXECUTE ON FUNCTION private.expire_walkie(), private.walkie_on_block(), private.orphan_voice_files(int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.orphan_voice_files(int) TO service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('expire-walkie', '37 * * * *', 'SELECT private.expire_walkie()');
  ELSE
    RAISE NOTICE 'expire-walkie not scheduled (pg_cron missing)';
  END IF;
END
$cron$;
