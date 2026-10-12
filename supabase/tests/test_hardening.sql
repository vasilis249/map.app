-- Hardening: the rules every table / function must follow (fails when a new one forgets), and account deletion.
\set ON_ERROR_STOP 0
\set QUIET on
CREATE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub', u, false);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false); END $$;
CREATE FUNCTION pg_temp.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '% %', CASE WHEN coalesce(cond, false) THEN 'PASS' ELSE 'FAIL' END, label; END $$;
CREATE FUNCTION pg_temp.err(stmt text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, anon;

-- 01 rules for every object of the app
SELECT pg_temp.ok('01a every table in public / private has row level security (' ||
  coalesce((SELECT string_agg(n.nspname || '.' || c.relname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r' AND n.nspname IN ('public', 'private') AND NOT c.relrowsecurity), 'all') || ')',
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind = 'r' AND n.nspname IN ('public', 'private') AND NOT c.relrowsecurity));
SELECT pg_temp.ok('01b every SECURITY DEFINER function pins search_path = '''' (' ||
  coalesce((SELECT string_agg(p.proname, ', ') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'private') AND p.prosecdef AND NOT coalesce(p.proconfig @> ARRAY['search_path=""'], false)), 'all') || ')',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('public', 'private') AND p.prosecdef AND NOT coalesce(p.proconfig @> ARRAY['search_path=""'], false)));
SELECT pg_temp.ok('01c anon (not signed in) can read / write no table',
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind = 'r' AND n.nspname IN ('public', 'private')
                AND (has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('anon', c.oid, 'INSERT')
                     OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE'))));
SELECT pg_temp.ok('01d anon can call no function of the app (' ||
  coalesce((SELECT string_agg(p.proname, ', ') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'private') AND has_function_privilege('anon', p.oid, 'EXECUTE')), 'none') || ')',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('public', 'private') AND has_function_privilege('anon', p.oid, 'EXECUTE')));
SELECT pg_temp.ok('01e signed-in users call only these private helpers (RLS policies need them)',
  (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private' AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  = ARRAY['is_blocked', 'nearby_topic_ok', 'walkie_topic_ok']);
SELECT pg_temp.ok('01f signed-in users never INSERT / DELETE a table directly, and see nothing in private',
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind = 'r' AND n.nspname IN ('public', 'private')
                AND (has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'DELETE')
                     OR (n.nspname = 'private' AND has_table_privilege('authenticated', c.oid, 'SELECT')))));
SELECT pg_temp.ok('01g the only direct UPDATEs: your own profile''s editable columns and a notice''s read_at (' ||
  (SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname)
   FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege('authenticated', c.oid, a.attname, 'UPDATE')) || ')',
  (SELECT bool_and(c.relname || '.' || a.attname IN ('profiles.full_name', 'profiles.username', 'profiles.bio', 'profiles.avatar_path', 'notifications.read_at'))
   FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege('authenticated', c.oid, a.attname, 'UPDATE')));

-- 02 delete my account: everything of theirs goes
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'anna@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"age_confirmed":true}');
\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.follow_user(:B);
SELECT public.set_location_sharing('everyone');
SELECT public.update_my_location(37.9755, 23.7348, 8);
SELECT public.road_report('police', 37.9755, 23.7348);
RESET ROLE;
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.follow_user(:A);
SELECT public.set_location_sharing('everyone');
SELECT public.update_my_location(37.9756, 23.7348, 8);
SELECT public.report_content('user', :A, 'spam');
SELECT public.road_vote((SELECT id FROM public.road_reports_in(37.9, 23.7, 38, 23.8) LIMIT 1), 1);
RESET ROLE;
INSERT INTO public.walkie_messages (sender_id, recipient_id, duration_ms) VALUES (:A, :B, 1000), (:B, :A, 1000);
INSERT INTO private.admins (user_id) VALUES (:A);
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.report_content('user', :B, 'spam');
RESET ROLE;
UPDATE public.profiles SET disabled = true WHERE id = :A;
SELECT pg_temp.ok('02a set-up: Anna has a profile, follows, position, talks, a road report, rate events, admin rights',
  (SELECT count(*) FROM public.follows WHERE :A IN (follower_id, followee_id)) = 2
  AND EXISTS (SELECT 1 FROM private.user_locations WHERE user_id = :A)
  AND EXISTS (SELECT 1 FROM private.road_reports WHERE created_by = :A)
  AND EXISTS (SELECT 1 FROM private.rate_events WHERE user_id = :A));
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('02b a disabled account can still delete itself', pg_temp.err('SELECT public.delete_my_account()') = 'ok');
RESET ROLE;
SELECT pg_temp.ok('02c … nothing of Anna is left (profile, follows, sharing, position, talks, notices, road report + its votes, reports about her, rate events, admin)',
  NOT EXISTS (SELECT 1 FROM auth.users WHERE id = :A)
  AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = :A)
  AND NOT EXISTS (SELECT 1 FROM public.follows WHERE :A IN (follower_id, followee_id))
  AND NOT EXISTS (SELECT 1 FROM public.location_sharing WHERE user_id = :A)
  AND NOT EXISTS (SELECT 1 FROM private.user_locations WHERE user_id = :A)
  AND NOT EXISTS (SELECT 1 FROM public.walkie_messages WHERE :A IN (sender_id, recipient_id))
  AND NOT EXISTS (SELECT 1 FROM public.notifications WHERE :A IN (user_id, actor_id))
  AND NOT EXISTS (SELECT 1 FROM private.road_reports WHERE created_by = :A)
  AND NOT EXISTS (SELECT 1 FROM private.road_votes)
  AND NOT EXISTS (SELECT 1 FROM public.reports WHERE target_user_id = :A)
  AND NOT EXISTS (SELECT 1 FROM private.rate_events WHERE user_id = :A)
  AND NOT EXISTS (SELECT 1 FROM private.admins WHERE user_id = :A));
SELECT pg_temp.ok('02d her report about Bob stays for the moderators, without her',
  (SELECT reporter_id IS NULL FROM public.reports WHERE target_user_id = :B));
SELECT pg_temp.ok('02e Bob is untouched', EXISTS (SELECT 1 FROM public.profiles WHERE id = :B) AND EXISTS (SELECT 1 FROM private.user_locations WHERE user_id = :B));
SET ROLE anon;
SELECT pg_temp.ok('02f not signed in: no deleting anyone', pg_temp.err('SELECT public.delete_my_account()') LIKE 'permission denied%');
RESET ROLE;

-- 03 profile photos: you can list (and remove) only your own folder
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('00000000-0000-0000-0000-00000000000c', 'chris@x', '{"age_confirmed":true}');
\set C '''00000000-0000-0000-0000-00000000000c'''
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('avatars', '00000000-0000-0000-0000-00000000000b/avatar-1.jpg'),
  ('avatars', '00000000-0000-0000-0000-00000000000b/avatar-2.jpg'),
  ('avatars', '00000000-0000-0000-0000-00000000000c/avatar-1.jpg');
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('03a Bob lists his own two photos, not Chris''s',
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'avatars') = 2
  AND NOT EXISTS (SELECT 1 FROM storage.objects WHERE name LIKE '00000000-0000-0000-0000-00000000000c/%'));
DELETE FROM storage.objects WHERE bucket_id = 'avatars' AND name = '00000000-0000-0000-0000-00000000000c/avatar-1.jpg';
RESET ROLE;
SELECT pg_temp.ok('03b … and can''t delete Chris''s', EXISTS (SELECT 1 FROM storage.objects WHERE name = '00000000-0000-0000-0000-00000000000c/avatar-1.jpg'));
