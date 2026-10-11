-- Speak S3: people. Follows replace friendships everywhere (DMs = mutual follows), the BeReal-style
-- daily posts go away, notifications become follow / like / reply / repost, plus follower lists,
-- suggestions and name search.

-- ---------------------------------------------------------------------------
-- 1. "Friends" (who may DM each other) = mutual follows
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.are_friends(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.follows(a, b) AND private.follows(b, a)
$$;

-- ---------------------------------------------------------------------------
-- 2. Remove friendships and daily posts (replaced by follows and public posts)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS daily_posts_upload_own ON storage.objects;
DROP POLICY IF EXISTS daily_posts_read ON storage.objects;
DROP POLICY IF EXISTS daily_posts_delete_own ON storage.objects;
DROP FUNCTION public.my_friends();
DROP FUNCTION public.send_friend_request(uuid);
DROP FUNCTION public.accept_friend_request(uuid);
DROP FUNCTION public.remove_friend(uuid);
DROP FUNCTION public.publish_daily_post(text, text, int);
DROP FUNCTION public.feed();
DROP FUNCTION public.today();
DROP FUNCTION private.can_listen_post(text);
DROP FUNCTION private.has_posted_current(uuid);
DROP TABLE public.daily_posts;
DROP TABLE public.friendships;
-- The empty `daily-posts` bucket is removed through the Storage API.

-- The daily prompt: moment, prompt times and the day's topic (if an admin set one).
CREATE FUNCTION public.today()
RETURNS TABLE (moment date, prompt_at timestamptz, next_prompt_at timestamptz, topic_id uuid, topic_title text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  m date := private.current_moment();
BEGIN
  RETURN QUERY
  SELECT m, private.prompt_at(m), private.prompt_at(m + 1), t.id, t.title
  FROM (SELECT 1) x
  LEFT JOIN public.topics t ON t.daily_date = m AND NOT t.hidden;
END $$;

CREATE OR REPLACE FUNCTION public.block_user(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_user IS NULL OR p_user = uid OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.blocks (blocker_id, blocked_id) VALUES (uid, p_user) ON CONFLICT DO NOTHING;
  DELETE FROM public.follows WHERE (follower_id = uid AND followee_id = p_user) OR (follower_id = p_user AND followee_id = uid);
  DELETE FROM public.notifications WHERE (user_id = uid AND actor_id = p_user) OR (user_id = p_user AND actor_id = uid);
  DELETE FROM private.voice_message_audio a USING public.voice_messages m
  WHERE a.message_id = m.id AND m.sender_id = p_user AND m.recipient_id = uid;
  UPDATE public.voice_messages SET expired_at = now()
  WHERE sender_id = p_user AND recipient_id = uid AND opened_at IS NULL AND expired_at IS NULL;
END $$;

DELETE FROM public.reports WHERE kind = 'daily_post';
ALTER TABLE public.reports DROP CONSTRAINT reports_kind_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_kind_check CHECK (kind IN ('user', 'voice_message', 'post'));

CREATE OR REPLACE FUNCTION public.report_content(p_kind text, p_target uuid, p_reason text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  target_user uuid;
BEGIN
  IF p_kind = 'user' THEN
    SELECT id INTO target_user FROM public.profiles WHERE id = p_target;
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

-- ---------------------------------------------------------------------------
-- 3. Notifications: follow / like / reply / repost (created by triggers)
-- ---------------------------------------------------------------------------
DELETE FROM public.notifications;
ALTER TABLE public.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('follow', 'like', 'reply', 'repost'));
ALTER TABLE public.notifications ADD COLUMN post_id uuid REFERENCES public.posts (id) ON DELETE CASCADE;

DROP FUNCTION private.notify(uuid, uuid, text);
-- One row per (recipient, actor, kind, post): repeats move to the top instead of piling up.
CREATE FUNCTION private.notify(p_user uuid, p_actor uuid, p_kind text, p_post uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user IS NULL OR p_user = p_actor OR private.is_blocked(p_user, p_actor) THEN RETURN; END IF;
  DELETE FROM public.notifications
  WHERE user_id = p_user AND actor_id = p_actor AND kind = p_kind AND post_id IS NOT DISTINCT FROM p_post;
  INSERT INTO public.notifications (user_id, actor_id, kind, post_id) VALUES (p_user, p_actor, p_kind, p_post);
END $$;

CREATE FUNCTION private.notify_follow()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.notify(NEW.followee_id, NEW.follower_id, 'follow');
  RETURN NEW;
END $$;
CREATE TRIGGER follows_notify AFTER INSERT ON public.follows FOR EACH ROW EXECUTE FUNCTION private.notify_follow();

CREATE FUNCTION private.notify_like()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.notify((SELECT author_id FROM public.posts WHERE id = NEW.post_id), NEW.user_id, 'like', NEW.post_id);
  RETURN NEW;
END $$;
CREATE TRIGGER post_likes_notify AFTER INSERT ON public.post_likes FOR EACH ROW EXECUTE FUNCTION private.notify_like();

-- Replies and reposts/quotes point at the parent / original post.
CREATE FUNCTION private.notify_post()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.reply_to IS NOT NULL THEN
    PERFORM private.notify((SELECT author_id FROM public.posts WHERE id = NEW.reply_to), NEW.author_id, 'reply', NEW.reply_to);
  ELSIF NEW.repost_of IS NOT NULL THEN
    PERFORM private.notify((SELECT author_id FROM public.posts WHERE id = NEW.repost_of), NEW.author_id, 'repost', NEW.repost_of);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER posts_notify AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION private.notify_post();

-- ---------------------------------------------------------------------------
-- 4. People: search (username or name, Greek or Latin), follower lists, suggestions
-- ---------------------------------------------------------------------------
DROP FUNCTION public.search_users(text);
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

-- Followers or following of a user (blocked people left out).
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

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION private.notify(uuid, uuid, text, uuid), private.notify_follow(), private.notify_like(),
  private.notify_post() FROM PUBLIC, authenticated;
