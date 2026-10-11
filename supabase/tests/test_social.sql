-- Profiles, follows (friends = mutual), notifications, blocks, reports, rate limits, privileges.
\set ON_ERROR_STOP 0
\set QUIET on
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'anna@x', '{"age_confirmed":true,"full_name":"Άννα Παπαδοπούλου"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"age_confirmed":true,"full_name":"Bob", "username":"bob"}'),
  ('00000000-0000-0000-0000-00000000000c', 'chris@x', '{"age_confirmed":true,"full_name":"Chris"}'),
  ('00000000-0000-0000-0000-00000000000d', 'xy@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000e', 'bob2@x', '{"age_confirmed":true,"username":"bob"}');

CREATE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub', u, false);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false); END $$;
CREATE FUNCTION pg_temp.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '% %', CASE WHEN coalesce(cond, false) THEN 'PASS' ELSE 'FAIL' END, label; END $$;
CREATE FUNCTION pg_temp.fails(stmt text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN true; END $$;
CREATE FUNCTION pg_temp.err(stmt text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, anon;

\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''
\set C '''00000000-0000-0000-0000-00000000000c'''
\set D '''00000000-0000-0000-0000-00000000000d'''
\set E '''00000000-0000-0000-0000-00000000000e'''

-- 01 profiles
SELECT pg_temp.ok('01a a profile per account; usernames from the name (Greek → Latin), the chosen one, or the email',
  (SELECT username FROM public.profiles WHERE id = :A) = 'anna.papadopoulou'
  AND (SELECT username FROM public.profiles WHERE id = :B) = 'bob'
  AND (SELECT username FROM public.profiles WHERE id = :D) = 'userxy'
  AND (SELECT full_name FROM public.profiles WHERE id = :A) = 'Άννα Παπαδοπούλου');
SELECT pg_temp.ok('01b a taken username gets a number', (SELECT username ~ '^bob[0-9]{4}$' FROM public.profiles WHERE id = :E));
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
-- (a write and the check of it go in separate statements: one statement doesn't see its own function's writes)
SELECT set_config('app.r', pg_temp.err($$UPDATE public.profiles SET full_name = 'Anna P', username = 'anna', bio = 'Οδηγώ ταξί' WHERE id = '00000000-0000-0000-0000-00000000000a'$$), false);
SELECT pg_temp.ok('01c edit your own name, username and bio',
  current_setting('app.r') = 'ok' AND (SELECT username = 'anna' AND bio = 'Οδηγώ ταξί' FROM public.profiles WHERE id = :A));
SELECT pg_temp.ok('01d bad username / too long bio / someone else''s row / disabled flag: refused or no effect',
  pg_temp.fails($$UPDATE public.profiles SET username = 'Anna!' WHERE id = '00000000-0000-0000-0000-00000000000a'$$)
  AND pg_temp.fails($$UPDATE public.profiles SET username = 'bob' WHERE id = '00000000-0000-0000-0000-00000000000a'$$)
  AND pg_temp.fails(format($$UPDATE public.profiles SET bio = %L WHERE id = '00000000-0000-0000-0000-00000000000a'$$, repeat('x', 161)))
  AND pg_temp.fails($$UPDATE public.profiles SET disabled = true WHERE id = '00000000-0000-0000-0000-00000000000a'$$));
UPDATE public.profiles SET full_name = 'Hacked' WHERE id = '00000000-0000-0000-0000-00000000000b';
RESET ROLE;
SELECT pg_temp.ok('01e … Bob''s row untouched', (SELECT full_name FROM public.profiles WHERE id = :B) = 'Bob');
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('01f avatar path must be in your own folder',
  pg_temp.fails($$UPDATE public.profiles SET avatar_path = '00000000-0000-0000-0000-00000000000b/x.jpg' WHERE id = '00000000-0000-0000-0000-00000000000a'$$)
  AND pg_temp.err($$UPDATE public.profiles SET avatar_path = '00000000-0000-0000-0000-00000000000a/x.jpg' WHERE id = '00000000-0000-0000-0000-00000000000a'$$) = 'ok');
SELECT pg_temp.ok('01g search by name (Greek or Latin) and username, not yourself',
  EXISTS (SELECT 1 FROM public.search_users('bob') WHERE id = :B)
  AND NOT EXISTS (SELECT 1 FROM public.search_users('anna') WHERE id = :A));
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('01h … Anna found as "Άννα" and "anna"',
  EXISTS (SELECT 1 FROM public.search_users('Άννα') WHERE id = :A) AND EXISTS (SELECT 1 FROM public.search_users('anna') WHERE id = :A));
RESET ROLE;

-- 02 follows, friends, notifications
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.follow_user(:B);
SELECT pg_temp.ok('02a follow: no approval, one-way, idempotent; not yourself',
  pg_temp.err(format('SELECT public.follow_user(%L)', :B)) = 'ok'
  AND (SELECT i_follow AND NOT follows_me AND followers = 1 FROM public.profile_stats(:B))
  AND pg_temp.fails(format('SELECT public.follow_user(%L)', :A)));
SELECT pg_temp.ok('02b no direct writes to follows', pg_temp.fails(format('INSERT INTO public.follows VALUES (%L, %L)', :A, :C)));
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('02c Bob got a follow notice from Anna (and nobody else sees it)',
  (SELECT count(*) FROM public.notifications WHERE kind = 'follow' AND actor_id = :A) = 1);
SELECT public.follow_user(:A);
SELECT pg_temp.ok('02d follow back → friends (mutual), lists both ways',
  (SELECT i_follow AND follows_me FROM public.profile_stats(:A))
  AND EXISTS (SELECT 1 FROM public.follow_list(:A, 'followers') WHERE id = :B)
  AND EXISTS (SELECT 1 FROM public.follow_list(:A, 'following') WHERE id = :B));
RESET ROLE; SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('02e others see who follows whom (public) but not other people''s notices',
  (SELECT count(*) FROM public.follows) = 2 AND NOT EXISTS (SELECT 1 FROM public.notifications));
SELECT pg_temp.ok('02f suggestions: not yourself, not people you follow', NOT EXISTS (SELECT 1 FROM public.suggested_people() WHERE id = :C));
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.unfollow_user(:B);
SELECT pg_temp.ok('02g unfollow', (SELECT NOT i_follow AND follows_me FROM public.profile_stats(:B)));
SELECT public.follow_user(:B);
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('02h a repeat follow moves the notice to the top instead of piling up',
  (SELECT count(*) FROM public.notifications WHERE kind = 'follow' AND actor_id = :A) = 1);
SELECT set_config('app.r', pg_temp.err('UPDATE public.notifications SET read_at = now()'), false);
SELECT pg_temp.ok('02i mark your notices read (only read_at)',
  current_setting('app.r') = 'ok' AND pg_temp.fails('UPDATE public.notifications SET kind = ''walkie''')
  AND NOT EXISTS (SELECT 1 FROM public.notifications WHERE read_at IS NULL));
RESET ROLE;

-- 03 blocks
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.follow_user(:A);
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.block_user(:C);
SELECT pg_temp.ok('03a blocking ends follows both ways, hides profile / search / lists / stats both ways',
  NOT EXISTS (SELECT 1 FROM public.follows WHERE :C IN (follower_id, followee_id))
  AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = :C)
  AND NOT EXISTS (SELECT 1 FROM public.search_users('chris'))
  AND NOT EXISTS (SELECT 1 FROM public.profile_stats(:C))
  AND EXISTS (SELECT 1 FROM public.my_blocked() WHERE id = :C));
RESET ROLE; SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('03b … for the blocked one too, who can''t follow back and sees no notice',
  NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = :A)
  AND pg_temp.fails(format('SELECT public.follow_user(%L)', :A))
  AND NOT EXISTS (SELECT 1 FROM public.follow_list(:A, 'followers'))
  AND NOT EXISTS (SELECT 1 FROM public.blocks));
RESET ROLE;
SELECT pg_temp.ok('03c the follow notice from the blocked one is gone', NOT EXISTS (SELECT 1 FROM public.notifications WHERE actor_id = :C AND user_id = :A));
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.unblock_user(:C);
SELECT pg_temp.ok('03d unblock: visible again, follows not restored', EXISTS (SELECT 1 FROM public.profiles WHERE id = :C)
  AND NOT EXISTS (SELECT 1 FROM public.follows WHERE :C IN (follower_id, followee_id)));
RESET ROLE;

-- 04 reports, admins
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('04a report a person (reason kept, max 500 chars); not yourself, not nobody',
  pg_temp.err(format('SELECT public.report_content(''user'', %L, %L)', :C, repeat('x', 900))) = 'ok'
  AND pg_temp.err(format('SELECT public.report_content(''user'', %L)', :A)) = 'not_found'
  AND pg_temp.err('SELECT public.report_content(''walkie'', gen_random_uuid())') = 'not_found');
SELECT pg_temp.ok('04b reports are invisible to clients', pg_temp.fails('SELECT * FROM public.reports'));
SELECT pg_temp.ok('04c not an admin', NOT public.am_i_admin());
RESET ROLE;
SELECT pg_temp.ok('04d the report is stored with the target', (SELECT char_length(reason) = 500 AND target_user_id = :C FROM public.reports));
INSERT INTO private.admins (user_id) VALUES (:B);
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('04e an admin is told so', public.am_i_admin());
RESET ROLE;

-- 05 rate limits, disabled accounts
SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT public.report_content('user', :C) FROM generate_series(1, 20);
SELECT pg_temp.ok('05a the 21st report within an hour: rate_limited', pg_temp.err(format('SELECT public.report_content(''user'', %L)', :C)) = 'rate_limited');
RESET ROLE;
UPDATE public.profiles SET disabled = true WHERE id = :D;
SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT pg_temp.ok('05b a disabled account can do nothing', pg_temp.err(format('SELECT public.follow_user(%L)', :A)) = 'not_allowed'
  AND pg_temp.fails('SELECT * FROM public.map_people()'));
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('05c … and is hidden from others', NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = :D)
  AND NOT EXISTS (SELECT 1 FROM public.search_users('userxy')));
RESET ROLE;

-- 05d age gate: an account without the 18+ declaration can do nothing until it confirms
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'young@x', '{"full_name":"No Age", "age_confirmed":"yes"}');
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000f1'); SET ROLE authenticated;
SELECT pg_temp.ok('05d no declaration (only a JSON true counts): every RPC says age_not_confirmed',
  pg_temp.err(format('SELECT public.follow_user(%L)', :A)) = 'age_not_confirmed'
  AND pg_temp.err('SELECT * FROM public.map_people()') = 'age_not_confirmed'
  AND pg_temp.err($$SELECT public.set_location_sharing('everyone')$$) = 'age_not_confirmed'
  AND pg_temp.err($$SELECT public.update_my_location(37.9, 23.7)$$) = 'age_not_confirmed');
SELECT pg_temp.ok('05e the flag can''t be set by hand',
  pg_temp.fails($$UPDATE public.profiles SET age_confirmed_at = now() WHERE id = '00000000-0000-0000-0000-0000000000f1'$$));
SELECT public.confirm_age();
SELECT pg_temp.ok('05f confirm_age() → RPCs work', pg_temp.err(format('SELECT public.follow_user(%L)', :A)) = 'ok');
RESET ROLE;
SELECT pg_temp.ok('05g the declaration time is kept', (SELECT age_confirmed_at IS NOT NULL FROM public.profiles WHERE id = '00000000-0000-0000-0000-0000000000f1'));
SET ROLE anon;
SELECT pg_temp.ok('05h anon can''t confirm', pg_temp.fails('SELECT public.confirm_age()'));
RESET ROLE;

-- 06 privileges
SET ROLE anon;
SELECT pg_temp.ok('06a anon: no tables, no RPCs', pg_temp.fails('SELECT * FROM public.profiles')
  AND pg_temp.fails('SELECT * FROM public.search_users(''bob'')') AND pg_temp.fails('SELECT public.am_i_admin()'));
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('06b authenticated: no private tables, no mutating helpers',
  pg_temp.fails('SELECT * FROM private.rate_events') AND pg_temp.fails('SELECT * FROM private.admins')
  AND pg_temp.fails($$SELECT private.rate_limit('x', 1, '1 hour')$$)
  AND pg_temp.fails(format($$SELECT private.notify(%L, %L, 'follow')$$, :B, :A))
  AND pg_temp.fails('SELECT private.me()'));
RESET ROLE;
SELECT pg_temp.ok('06c every SECURITY DEFINER function pins search_path',
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosecdef AND p.pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
              AND NOT coalesce(p.proconfig, '{}') @> ARRAY['search_path=""']));
SELECT pg_temp.ok('06d every table in public / private has RLS on',
  NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace IN ('public'::regnamespace, 'private'::regnamespace)
              AND NOT c.relrowsecurity));
SELECT pg_temp.ok('06e anon can execute nothing in public',
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE')));

-- 07 account deletion cascades
DELETE FROM auth.users WHERE id = :C;
SELECT pg_temp.ok('07a deleting an account removes its profile, follows and reports about it',
  NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = :C) AND NOT EXISTS (SELECT 1 FROM public.reports WHERE target_user_id = :C));
