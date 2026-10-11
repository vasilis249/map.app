-- student-gate (SPEC.md): only verified students (or admins) use Speak. One check, where it already is:
--  * private.me() — the caller check used by every content RPC (feed, topics, people, DMs, walkie, map, groups…) —
--    now also requires a student (`not_student`, 42501). The old check lives on as private.me_any() for the few
--    things an unverified account must still do: verify its academic email and claim an invite.
--  * Table policies that showed other people's rows (profiles, posts, topics, follows, groups, group members) and the
--    walkie / map-talk Realtime channels add the same check. Your own rows stay yours.
--  * private.app_flags('student_gate') switches the gate (on in production; older test suites turn it off).
--  The App Review demo account is simply a verified student (docs/release-checklist.md).

CREATE TABLE private.app_flags (key text PRIMARY KEY, enabled boolean NOT NULL);
INSERT INTO private.app_flags VALUES ('student_gate', true) ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION private.is_student(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_user IS NOT NULL AND (
    NOT coalesce((SELECT enabled FROM private.app_flags WHERE key = 'student_gate'), true)
    OR private.is_admin(p_user)
    OR EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND university_id IS NOT NULL AND NOT disabled))
$$;

-- the old private.me(): signed in and not disabled
CREATE FUNCTION private.me_any()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = uid AND NOT disabled) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  RETURN uid;
END $$;

CREATE OR REPLACE FUNCTION private.me()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me_any();
BEGIN
  IF NOT private.is_student(uid) THEN
    RAISE EXCEPTION 'not_student' USING ERRCODE = '42501';
  END IF;
  RETURN uid;
END $$;
REVOKE EXECUTE ON FUNCTION private.is_student(uuid), private.me_any() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_student(uuid) TO authenticated; -- used inside table / Realtime policies

-- What an unverified account may still do: verify itself, claim the invite that brought it.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.verify_student_code(text)', 'public.claim_invite(text)'] LOOP
    EXECUTE replace(pg_get_functiondef(f::regprocedure), 'private.me()', 'private.me_any()');
  END LOOP;
END $$;

-- Table policies: other people's rows only for students.
DROP POLICY profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR (private.is_student(auth.uid()) AND NOT disabled AND NOT private.is_blocked(auth.uid(), id)));

DROP POLICY posts_select ON public.posts;
CREATE POLICY posts_select ON public.posts FOR SELECT TO authenticated
  USING (author_id = auth.uid() OR (private.is_student(auth.uid()) AND private.can_see_post(id)));

DROP POLICY topics_select ON public.topics;
CREATE POLICY topics_select ON public.topics FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid())
         OR (private.is_student(auth.uid()) AND NOT hidden AND (university_id IS NULL OR university_id = private.my_university())));

DROP POLICY follows_select ON public.follows;
CREATE POLICY follows_select ON public.follows FOR SELECT TO authenticated
  USING (private.is_student(auth.uid())
         AND NOT private.is_blocked(auth.uid(), follower_id) AND NOT private.is_blocked(auth.uid(), followee_id));

DROP POLICY groups_select ON public.groups;
CREATE POLICY groups_select ON public.groups FOR SELECT TO authenticated USING (private.is_student(auth.uid()));

DROP POLICY group_members_select ON public.group_members;
CREATE POLICY group_members_select ON public.group_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR (private.is_student(auth.uid()) AND private.can_see_group(auth.uid(), group_id)));

-- Live audio channels (walkie-talkie, talk on the map): students only.
DROP POLICY walkie_read ON realtime.messages;
CREATE POLICY walkie_read ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() LIKE 'walkie:%' AND private.is_student(auth.uid()) AND private.walkie_topic_ok(realtime.topic()));
DROP POLICY walkie_write ON realtime.messages;
CREATE POLICY walkie_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() LIKE 'walkie:%' AND private.is_student(auth.uid()) AND private.walkie_topic_ok(realtime.topic()));
DROP POLICY nearby_read ON realtime.messages;
CREATE POLICY nearby_read ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() LIKE 'nearby:%' AND private.is_student(auth.uid()) AND private.nearby_topic_ok(realtime.topic()));
DROP POLICY nearby_write ON realtime.messages;
CREATE POLICY nearby_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() LIKE 'nearby:%' AND private.is_student(auth.uid()) AND private.nearby_topic_ok(realtime.topic()));

-- The app asks the same question (so the flag, admins and verification are decided in one place).
CREATE FUNCTION public.am_i_student()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_student(auth.uid())
$$;
REVOKE EXECUTE ON FUNCTION public.am_i_student() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.am_i_student() TO authenticated;
