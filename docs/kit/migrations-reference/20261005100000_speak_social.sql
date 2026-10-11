-- Speak: voice-first public social network ("X with voice").
-- Adds follows, sections, topics, posts (voice ≤ 2 min + optional title; replies, reposts, quotes),
-- likes and listens, with RLS and RPCs. Additive: friendships / daily_posts stay until the new UI
-- replaces them (S2/S3), then a cleanup migration drops them.

-- ---------------------------------------------------------------------------
-- 1. Admins (topic management, moderation). Granted by SQL only.
-- ---------------------------------------------------------------------------
CREATE TABLE private.admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.admins FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.is_admin(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM private.admins WHERE user_id = p_user)
$$;

-- Am I an admin? (shows the admin tools in the app; answers only about the caller)
CREATE FUNCTION public.am_i_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_admin(auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- 2. Follows (public, asymmetric, no approval)
-- ---------------------------------------------------------------------------
CREATE TABLE public.follows (
  follower_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee ON public.follows (followee_id, created_at DESC);

CREATE FUNCTION private.follows(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.follows WHERE follower_id = a AND followee_id = b)
$$;

-- Existing friendships become follows: accepted → both ways, pending → requester follows.
INSERT INTO public.follows (follower_id, followee_id, created_at)
SELECT f.user_a, f.user_b, coalesce(f.accepted_at, f.created_at) FROM public.friendships f
WHERE f.status = 'accepted' OR f.requested_by = f.user_a
ON CONFLICT DO NOTHING;
INSERT INTO public.follows (follower_id, followee_id, created_at)
SELECT f.user_b, f.user_a, coalesce(f.accepted_at, f.created_at) FROM public.friendships f
WHERE f.status = 'accepted' OR f.requested_by = f.user_b
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Sections (fixed list) and topics (admin-created, news, daily)
-- ---------------------------------------------------------------------------
CREATE TABLE public.sections (
  id text PRIMARY KEY CHECK (id ~ '^[a-z]{2,20}$'),
  position int NOT NULL,
  name_el text NOT NULL,
  name_en text NOT NULL,
  icon text NOT NULL
);
INSERT INTO public.sections (id, position, name_el, name_en, icon) VALUES
  ('news', 1, 'Επικαιρότητα', 'News', 'newspaper'),
  ('tech', 2, 'Tech', 'Tech', 'cpu'),
  ('sports', 3, 'Αθλητικά', 'Sports', 'trophy'),
  ('economy', 4, 'Οικονομία', 'Economy', 'trending-up'),
  ('politics', 5, 'Πολιτική', 'Politics', 'landmark'),
  ('entertainment', 6, 'Ψυχαγωγία', 'Entertainment', 'clapperboard'),
  ('lifestyle', 7, 'Lifestyle', 'Lifestyle', 'sparkles'),
  ('humor', 8, 'Χιούμορ', 'Humor', 'laugh');

CREATE TABLE public.topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id text NOT NULL REFERENCES public.sections (id),
  kind text NOT NULL DEFAULT 'topic' CHECK (kind IN ('topic', 'news', 'daily')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  summary text CHECK (char_length(summary) <= 600),
  source_name text CHECK (char_length(source_name) <= 80),
  source_url text CHECK (source_url IS NULL OR (source_url ~ '^https?://' AND char_length(source_url) <= 1000)),
  external_id text UNIQUE,            -- RSS guid/link, for de-duplication
  daily_date date UNIQUE,             -- set for kind = 'daily' (one per day)
  pinned boolean NOT NULL DEFAULT false,
  hidden boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  posts_count int NOT NULL DEFAULT 0,
  last_post_at timestamptz,
  CHECK ((kind = 'daily') = (daily_date IS NOT NULL))
);
CREATE INDEX topics_section ON public.topics (section_id, created_at DESC) WHERE NOT hidden;
CREATE INDEX topics_active ON public.topics (last_post_at DESC NULLS LAST) WHERE NOT hidden;

-- ---------------------------------------------------------------------------
-- 4. Posts: voice (≤ 2 min) + optional title; replies (reply_to), reposts and quotes (repost_of)
--    Files live in the public `voices` bucket under <author id>/.
-- ---------------------------------------------------------------------------
CREATE TABLE public.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  section_id text NOT NULL REFERENCES public.sections (id),
  topic_id uuid REFERENCES public.topics (id) ON DELETE SET NULL,
  reply_to uuid REFERENCES public.posts (id) ON DELETE CASCADE,
  repost_of uuid REFERENCES public.posts (id) ON DELETE CASCADE,
  title text CHECK (char_length(title) BETWEEN 1 AND 100),
  audio_path text UNIQUE CHECK (char_length(audio_path) <= 200),
  mime text,
  duration_ms int CHECK (duration_ms BETWEEN 1000 AND 120000),
  created_at timestamptz NOT NULL DEFAULT now(),
  likes_count int NOT NULL DEFAULT 0,
  replies_count int NOT NULL DEFAULT 0,
  reposts_count int NOT NULL DEFAULT 0,
  listens_count int NOT NULL DEFAULT 0,
  hidden boolean NOT NULL DEFAULT false,        -- moderation
  -- a voice post has audio; a plain repost has none (a quote = repost_of + audio)
  CHECK ((audio_path IS NOT NULL AND mime IS NOT NULL AND duration_ms IS NOT NULL)
         OR (audio_path IS NULL AND mime IS NULL AND duration_ms IS NULL AND repost_of IS NOT NULL AND title IS NULL)),
  CHECK (reply_to IS NULL OR repost_of IS NULL)
);
CREATE INDEX posts_recent ON public.posts (created_at DESC) WHERE reply_to IS NULL AND NOT hidden;
CREATE INDEX posts_section ON public.posts (section_id, created_at DESC) WHERE reply_to IS NULL AND NOT hidden;
CREATE INDEX posts_topic ON public.posts (topic_id, created_at DESC) WHERE NOT hidden;
CREATE INDEX posts_author ON public.posts (author_id, created_at DESC);
CREATE INDEX posts_replies ON public.posts (reply_to, created_at) WHERE reply_to IS NOT NULL;
CREATE UNIQUE INDEX posts_one_plain_repost ON public.posts (author_id, repost_of) WHERE audio_path IS NULL;

CREATE TABLE public.post_likes (
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_likes_user ON public.post_likes (user_id, created_at DESC);

-- One listen per person per post (the author's own plays don't count).
CREATE TABLE public.post_listens (
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- Can the caller see this post? (not hidden, author active and not blocked either way)
CREATE FUNCTION private.can_see_post(p_post uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.posts p JOIN public.profiles a ON a.id = p.author_id
    WHERE p.id = p_post AND NOT p.hidden AND NOT a.disabled
      AND NOT private.is_blocked(auth.uid(), p.author_id))
$$;

-- Counters, kept by triggers (clients can't write them).
CREATE FUNCTION private.posts_counters()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reply_to IS NOT NULL THEN
      UPDATE public.posts SET replies_count = replies_count + 1 WHERE id = NEW.reply_to;
    END IF;
    IF NEW.repost_of IS NOT NULL THEN
      UPDATE public.posts SET reposts_count = reposts_count + 1 WHERE id = NEW.repost_of;
    END IF;
    IF NEW.topic_id IS NOT NULL AND NEW.reply_to IS NULL THEN
      UPDATE public.topics SET posts_count = posts_count + 1, last_post_at = NEW.created_at WHERE id = NEW.topic_id;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.reply_to IS NOT NULL THEN
    UPDATE public.posts SET replies_count = greatest(replies_count - 1, 0) WHERE id = OLD.reply_to;
  END IF;
  IF OLD.repost_of IS NOT NULL THEN
    UPDATE public.posts SET reposts_count = greatest(reposts_count - 1, 0) WHERE id = OLD.repost_of;
  END IF;
  IF OLD.topic_id IS NOT NULL AND OLD.reply_to IS NULL THEN
    UPDATE public.topics SET posts_count = greatest(posts_count - 1, 0) WHERE id = OLD.topic_id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER posts_counters AFTER INSERT OR DELETE ON public.posts
FOR EACH ROW EXECUTE FUNCTION private.posts_counters();

CREATE FUNCTION private.likes_counter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts SET likes_count = likes_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  END IF;
  UPDATE public.posts SET likes_count = greatest(likes_count - 1, 0) WHERE id = OLD.post_id;
  RETURN OLD;
END $$;
CREATE TRIGGER post_likes_counter AFTER INSERT OR DELETE ON public.post_likes
FOR EACH ROW EXECUTE FUNCTION private.likes_counter();

-- ---------------------------------------------------------------------------
-- 5. Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_listens ENABLE ROW LEVEL SECURITY;

CREATE POLICY follows_select ON public.follows FOR SELECT TO authenticated
  USING (NOT private.is_blocked(auth.uid(), follower_id) AND NOT private.is_blocked(auth.uid(), followee_id));
CREATE POLICY sections_select ON public.sections FOR SELECT TO authenticated USING (true);
CREATE POLICY topics_select ON public.topics FOR SELECT TO authenticated
  USING (NOT hidden OR private.is_admin(auth.uid()));
CREATE POLICY posts_select ON public.posts FOR SELECT TO authenticated
  USING (author_id = auth.uid() OR private.can_see_post(id));
CREATE POLICY posts_delete_own ON public.posts FOR DELETE TO authenticated
  USING (author_id = auth.uid());
CREATE POLICY post_likes_select_own ON public.post_likes FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- post_listens: no client access (record_listen()).

REVOKE ALL ON public.follows, public.sections, public.topics, public.posts, public.post_likes, public.post_listens
  FROM anon, authenticated;
GRANT ALL ON public.follows, public.sections, public.topics, public.posts, public.post_likes, public.post_listens
  TO service_role;
GRANT SELECT ON public.follows, public.sections, public.topics, public.posts, public.post_likes TO authenticated;
GRANT DELETE ON public.posts TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPCs
-- ---------------------------------------------------------------------------
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

-- Public profile card: counts and the relation to the caller.
CREATE FUNCTION public.profile_stats(p_user uuid)
RETURNS TABLE (followers int, following int, posts int, i_follow boolean, follows_me boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF private.is_blocked(uid, p_user) THEN RETURN; END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::int FROM public.follows WHERE followee_id = p_user),
    (SELECT count(*)::int FROM public.follows WHERE follower_id = p_user),
    (SELECT count(*)::int FROM public.posts WHERE author_id = p_user AND reply_to IS NULL AND NOT hidden),
    private.follows(uid, p_user),
    private.follows(p_user, uid);
END $$;

-- Create a post after uploading its audio to voices/<uid>/… (or a plain repost without audio).
-- Replies inherit the parent's section and topic.
CREATE FUNCTION public.create_post(
  p_section text DEFAULT NULL, p_topic uuid DEFAULT NULL, p_reply_to uuid DEFAULT NULL,
  p_repost_of uuid DEFAULT NULL, p_title text DEFAULT NULL, p_path text DEFAULT NULL,
  p_mime text DEFAULT NULL, p_duration_ms int DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  v_section text := p_section;
  v_topic uuid := p_topic;
  v_title text := nullif(trim(coalesce(p_title, '')), '');
  parent public.posts;
  pid uuid;
BEGIN
  IF p_reply_to IS NOT NULL THEN
    SELECT * INTO parent FROM public.posts WHERE id = p_reply_to;
    IF NOT FOUND OR NOT private.can_see_post(p_reply_to) THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
    END IF;
    v_section := parent.section_id;
    v_topic := parent.topic_id;
  ELSIF p_repost_of IS NOT NULL THEN
    SELECT * INTO parent FROM public.posts WHERE id = p_repost_of;
    IF NOT FOUND OR NOT private.can_see_post(p_repost_of) OR parent.audio_path IS NULL THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
    END IF;
    v_section := parent.section_id;
    v_topic := NULL;
  ELSIF v_topic IS NOT NULL THEN
    SELECT section_id INTO v_section FROM public.topics WHERE id = v_topic AND NOT hidden;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  END IF;
  IF v_section IS NULL OR NOT EXISTS (SELECT 1 FROM public.sections WHERE id = v_section) THEN
    RAISE EXCEPTION 'bad_section' USING ERRCODE = '22023';
  END IF;

  IF p_path IS NULL THEN
    -- plain repost: no audio, no title
    IF p_repost_of IS NULL OR v_title IS NOT NULL THEN
      RAISE EXCEPTION 'file_missing' USING ERRCODE = '22023';
    END IF;
  ELSIF NOT starts_with(p_path, uid::text || '/') OR char_length(p_path) > 200
     OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'voices' AND name = p_path) THEN
    RAISE EXCEPTION 'file_missing' USING ERRCODE = '22023';
  END IF;

  PERFORM private.rate_limit('post', 30, interval '1 hour');
  INSERT INTO public.posts (author_id, section_id, topic_id, reply_to, repost_of, title, audio_path, mime, duration_ms)
  VALUES (uid, v_section, v_topic, p_reply_to, p_repost_of, left(v_title, 100), p_path,
          CASE WHEN p_path IS NULL THEN NULL ELSE private.normalize_audio_mime(p_mime) END,
          CASE WHEN p_path IS NULL THEN NULL ELSE p_duration_ms END)
  RETURNING id INTO pid;
  RETURN pid;
END $$;

-- Undo a plain repost.
CREATE FUNCTION public.unrepost(p_post uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  DELETE FROM public.posts WHERE author_id = uid AND repost_of = p_post AND audio_path IS NULL;
END $$;

CREATE FUNCTION public.like_post(p_post uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF NOT private.can_see_post(p_post) THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM private.rate_limit('like', 300, interval '1 hour');
  INSERT INTO public.post_likes (user_id, post_id) VALUES (uid, p_post) ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION public.unlike_post(p_post uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  DELETE FROM public.post_likes WHERE user_id = uid AND post_id = p_post;
END $$;

-- Count a listen once per person (not the author).
CREATE FUNCTION public.record_listen(p_post uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF NOT private.can_see_post(p_post) OR EXISTS (SELECT 1 FROM public.posts WHERE id = p_post AND author_id = uid) THEN
    RETURN;
  END IF;
  INSERT INTO public.post_listens (user_id, post_id) VALUES (uid, p_post) ON CONFLICT DO NOTHING;
  IF FOUND THEN
    UPDATE public.posts SET listens_count = listens_count + 1 WHERE id = p_post;
  END IF;
END $$;

-- The one feed query. Scopes:
--   'all' (For you; recency for now), 'following' (people I follow + me), 'section' (p_section),
--   'topic' (p_topic, incl. replies = false), 'author' (p_author), 'replies' (replies to p_parent, oldest first).
-- Plain reposts carry the original post in the orig_* columns.
CREATE FUNCTION public.feed_posts(
  p_scope text, p_section text DEFAULT NULL, p_topic uuid DEFAULT NULL, p_author uuid DEFAULT NULL,
  p_parent uuid DEFAULT NULL, p_before timestamptz DEFAULT NULL, p_limit int DEFAULT 20)
RETURNS TABLE (
  post_id uuid, created_at timestamptz, author_id uuid, author_username text, author_name text, author_avatar text,
  section_id text, topic_id uuid, topic_title text, reply_to uuid, repost_of uuid, title text, audio_path text,
  duration_ms int, likes_count int, replies_count int, reposts_count int, listens_count int,
  liked boolean, reposted boolean, is_mine boolean,
  orig_author_username text, orig_author_name text, orig_author_avatar text, orig_title text,
  orig_audio_path text, orig_duration_ms int, orig_created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  lim int := least(greatest(coalesce(p_limit, 20), 1), 50);
BEGIN
  IF p_scope NOT IN ('all', 'following', 'section', 'topic', 'author', 'replies') THEN
    RAISE EXCEPTION 'bad_scope' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT p.id, p.created_at, a.id, a.username, a.full_name, a.avatar_path,
         p.section_id, p.topic_id, t.title, p.reply_to, p.repost_of, p.title, p.audio_path,
         p.duration_ms, p.likes_count, p.replies_count, p.reposts_count, p.listens_count,
         EXISTS (SELECT 1 FROM public.post_likes l WHERE l.post_id = coalesce(CASE WHEN p.audio_path IS NULL THEN p.repost_of END, p.id) AND l.user_id = uid),
         EXISTS (SELECT 1 FROM public.posts r WHERE r.repost_of = coalesce(CASE WHEN p.audio_path IS NULL THEN p.repost_of END, p.id) AND r.author_id = uid AND r.audio_path IS NULL),
         p.author_id = uid,
         oa.username, oa.full_name, oa.avatar_path, o.title, o.audio_path, o.duration_ms, o.created_at
  FROM public.posts p
  JOIN public.profiles a ON a.id = p.author_id
  LEFT JOIN public.topics t ON t.id = p.topic_id
  LEFT JOIN public.posts o ON o.id = p.repost_of
  LEFT JOIN public.profiles oa ON oa.id = o.author_id
  WHERE NOT p.hidden AND NOT a.disabled AND NOT private.is_blocked(uid, p.author_id)
    AND (o.id IS NULL OR (NOT o.hidden AND NOT oa.disabled AND NOT private.is_blocked(uid, o.author_id)))
    AND (p_before IS NULL OR (CASE WHEN p_scope = 'replies' THEN p.created_at > p_before ELSE p.created_at < p_before END))
    AND CASE p_scope
      WHEN 'all' THEN p.reply_to IS NULL
      WHEN 'following' THEN p.reply_to IS NULL AND (p.author_id = uid OR private.follows(uid, p.author_id))
      WHEN 'section' THEN p.reply_to IS NULL AND p.section_id = p_section
      WHEN 'topic' THEN p.reply_to IS NULL AND p.topic_id = p_topic
      WHEN 'author' THEN p.author_id = p_author AND p.reply_to IS NULL
      ELSE p.reply_to = p_parent
    END
  ORDER BY CASE WHEN p_scope = 'replies' THEN extract(epoch FROM p.created_at) ELSE -extract(epoch FROM p.created_at) END
  LIMIT lim;
END $$;

-- Topics with activity in the last 24 h first, then the newest (optionally for one section).
CREATE FUNCTION public.trending_topics(p_section text DEFAULT NULL, p_limit int DEFAULT 10)
RETURNS TABLE (id uuid, section_id text, kind text, title text, source_name text, source_url text,
               created_at timestamptz, posts_count int, recent_posts int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  RETURN QUERY
  SELECT t.id, t.section_id, t.kind, t.title, t.source_name, t.source_url, t.created_at, t.posts_count,
         (SELECT count(*)::int FROM public.posts p
          WHERE p.topic_id = t.id AND p.reply_to IS NULL AND NOT p.hidden AND p.created_at > now() - interval '24 hours')
  FROM public.topics t
  WHERE NOT t.hidden AND (p_section IS NULL OR t.section_id = p_section)
    AND t.created_at > now() - interval '14 days'
  ORDER BY t.pinned DESC, 9 DESC, t.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 10), 1), 50);
END $$;

-- Admin: create / hide / pin topics.
CREATE FUNCTION public.admin_create_topic(p_section text, p_title text, p_summary text DEFAULT NULL,
  p_source_name text DEFAULT NULL, p_source_url text DEFAULT NULL, p_daily_date date DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  tid uuid;
BEGIN
  IF NOT private.is_admin(uid) THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.topics (section_id, kind, title, summary, source_name, source_url, daily_date, created_by)
  VALUES (p_section, CASE WHEN p_daily_date IS NULL THEN 'topic' ELSE 'daily' END, trim(p_title),
          nullif(trim(coalesce(p_summary, '')), ''), nullif(trim(coalesce(p_source_name, '')), ''),
          nullif(trim(coalesce(p_source_url, '')), ''), p_daily_date, uid)
  RETURNING id INTO tid;
  RETURN tid;
END $$;

CREATE FUNCTION public.admin_update_topic(p_topic uuid, p_hidden boolean DEFAULT NULL, p_pinned boolean DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF NOT private.is_admin(uid) THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  UPDATE public.topics SET hidden = coalesce(p_hidden, hidden), pinned = coalesce(p_pinned, pinned) WHERE id = p_topic;
END $$;

-- Blocking also ends follows in both directions.
CREATE OR REPLACE FUNCTION public.block_user(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_user IS NULL OR p_user = uid OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.blocks (blocker_id, blocked_id) VALUES (uid, p_user) ON CONFLICT DO NOTHING;
  DELETE FROM public.friendships WHERE user_a = least(uid, p_user) AND user_b = greatest(uid, p_user);
  DELETE FROM public.follows WHERE (follower_id = uid AND followee_id = p_user) OR (follower_id = p_user AND followee_id = uid);
  DELETE FROM public.notifications WHERE (user_id = uid AND actor_id = p_user) OR (user_id = p_user AND actor_id = uid);
  DELETE FROM private.voice_message_audio a USING public.voice_messages m
  WHERE a.message_id = m.id AND m.sender_id = p_user AND m.recipient_id = uid;
  UPDATE public.voice_messages SET expired_at = now()
  WHERE sender_id = p_user AND recipient_id = uid AND opened_at IS NULL AND expired_at IS NULL;
END $$;

-- Reports may now target public posts too (anyone who can see the post).
ALTER TABLE public.reports DROP CONSTRAINT reports_kind_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_kind_check
  CHECK (kind IN ('user', 'daily_post', 'voice_message', 'post'));

CREATE OR REPLACE FUNCTION public.report_content(p_kind text, p_target uuid, p_reason text DEFAULT '')
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
  ELSIF p_kind = 'post' THEN
    SELECT p.author_id INTO target_user FROM public.posts p
    WHERE p.id = p_target AND (private.can_see_post(p.id) OR private.is_blocked(uid, p.author_id));
  END IF;
  IF target_user IS NULL OR target_user = uid THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM private.rate_limit('report', 20, interval '1 hour');
  INSERT INTO public.reports (reporter_id, target_user_id, kind, target_id, reason)
  VALUES (uid, target_user, p_kind, CASE WHEN p_kind = 'user' THEN NULL ELSE p_target END, left(coalesce(p_reason, ''), 500));
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION private.posts_counters(), private.likes_counter() FROM PUBLIC, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Storage: public `voices` bucket (served by URL, not listable), uploads into your own folder.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('voices', 'voices', true, 3145728,
        ARRAY['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/webm', 'audio/ogg'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY voices_upload_own ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'voices' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY voices_delete_own ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'voices' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 8. Realtime
-- ---------------------------------------------------------------------------
DO $realtime$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.follows, public.posts;
EXCEPTION WHEN undefined_object OR insufficient_privilege OR duplicate_object THEN
  RAISE NOTICE 'realtime publication not updated: %', SQLERRM;
END
$realtime$;
