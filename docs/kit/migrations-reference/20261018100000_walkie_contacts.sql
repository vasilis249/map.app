-- Walkie W2: hear friends anywhere in the app.
--   walkie_contacts: per friend, whether the channel stays open while you use the rest of the app ("channel on",
--   at most 10 — each is one Realtime channel on your connection) and when you last looked at it (unheard counts).
--   walkie_list(): your friends for the walkie screen. A saved transmission also leaves a 'walkie' notification
--   (one per friend, moved to the top by the next one), read when you open that friend's walkie.

CREATE TABLE public.walkie_contacts (
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  peer_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  channel_on boolean NOT NULL DEFAULT false,
  seen_at timestamptz,
  PRIMARY KEY (user_id, peer_id),
  CHECK (user_id <> peer_id)
);
ALTER TABLE public.walkie_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.walkie_contacts FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.walkie_contacts FROM authenticated;
CREATE POLICY walkie_contacts_select ON public.walkie_contacts FOR SELECT TO authenticated USING (user_id = auth.uid());

ALTER TABLE public.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('follow', 'like', 'reply', 'repost', 'report', 'group_invite', 'group_request', 'group_accepted',
                  'group_joined', 'invite_joined', 'walkie'));

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

REVOKE EXECUTE ON FUNCTION private.notify_walkie() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.walkie_list(), public.walkie_set_channel(uuid, boolean), public.walkie_seen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.walkie_list(), public.walkie_set_channel(uuid, boolean), public.walkie_seen(uuid) TO authenticated;
