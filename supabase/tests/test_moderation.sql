-- Moderation: the report queue (admins only), hearing a reported transmission, dismiss / disable, what a disabled
-- account loses; follower lists page through.
\set ON_ERROR_STOP 0
\set QUIET on
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'admin@x', '{"age_confirmed":true,"full_name":"Admin"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"age_confirmed":true,"full_name":"Bob"}'),
  ('00000000-0000-0000-0000-00000000000c', 'chris@x', '{"age_confirmed":true,"full_name":"Chris"}'),
  ('00000000-0000-0000-0000-00000000000d', 'dora@x', '{"age_confirmed":true,"full_name":"Dora"}'),
  ('00000000-0000-0000-0000-00000000000e', 'eva@x', '{"age_confirmed":true,"full_name":"Eva"}');
INSERT INTO private.admins (user_id) VALUES ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000e');
-- Bob and Chris are friends (walkie).
INSERT INTO public.follows (follower_id, followee_id) VALUES
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000c'),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000b');

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
SELECT set_config('app.b64', encode(convert_to(repeat('voice', 60), 'UTF8'), 'base64'), false);

-- Bob says something to Chris on the walkie; Chris and Dora report Bob (Chris: that transmission).
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.send_walkie(:C, current_setting('app.b64'), 'audio/mp4', 2000) AS msg \gset
RESET ROLE; SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.report_content('walkie', :'msg', 'harassment');
RESET ROLE; SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT public.report_content('user', :B, 'spam');
SELECT pg_temp.ok('01a a non-admin: no queue, no audio, no actions',
  pg_temp.err('SELECT * FROM public.admin_reports()') = 'not_allowed'
  AND pg_temp.err('SELECT * FROM public.admin_report_audio(gen_random_uuid())') = 'not_allowed'
  AND pg_temp.err(format('SELECT public.admin_set_disabled(%L, true)', :B)) = 'not_allowed'
  AND pg_temp.err('SELECT public.admin_resolve_report(gen_random_uuid(), ''dismiss'')') = 'not_allowed');
RESET ROLE; SET ROLE anon;
SELECT pg_temp.ok('01b anon: nothing', pg_temp.fails('SELECT * FROM public.admin_reports()'));
RESET ROLE;

-- 02 the queue
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('02a admin: both open reports, newest first, with the target and their open-report count',
  (SELECT count(*) FROM public.admin_reports()) = 2
  AND (SELECT bool_and(target_user_id = :B AND target_open_reports = 2) FROM public.admin_reports())
  AND (SELECT kind FROM public.admin_reports() LIMIT 1) = 'user');
SELECT pg_temp.ok('02b the reported transmission can be heard by the moderator',
  (SELECT has_audio FROM public.admin_reports() WHERE kind = 'walkie')
  AND (SELECT audio_b64 FROM public.admin_report_audio((SELECT id FROM public.admin_reports() WHERE kind = 'walkie'))) = current_setting('app.b64'));
SELECT id AS rep_user FROM public.admin_reports() WHERE kind = 'user' \gset
SELECT public.admin_resolve_report(:'rep_user', 'dismiss');
SELECT pg_temp.ok('02c dismiss: closed with who / when / why; one open left',
  (SELECT count(*) FROM public.admin_reports()) = 1
  AND (SELECT resolution = 'dismissed' AND resolved_at IS NOT NULL FROM public.admin_reports(false) WHERE id = :'rep_user'));
SELECT pg_temp.ok('02d bad action / unknown report / yourself / another admin refused',
  pg_temp.err(format('SELECT public.admin_resolve_report(%L, ''ban'')', :'rep_user')) = 'bad_action'
  AND pg_temp.err('SELECT public.admin_resolve_report(gen_random_uuid(), ''dismiss'')') = 'not_found'
  AND pg_temp.err(format('SELECT public.admin_set_disabled(%L, true)', :A)) = 'not_allowed'
  AND pg_temp.err(format('SELECT public.admin_set_disabled(%L, true)', :E)) = 'not_allowed');
RESET ROLE;
SELECT pg_temp.ok('02e resolved_by recorded', (SELECT resolved_by = :A FROM public.reports WHERE id = :'rep_user'));

-- 03 disable from the queue: Bob shares his location first
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.set_location_sharing('everyone');
SELECT public.update_my_location(37.9755, 23.7348, 10);
RESET ROLE; SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.walkie_set_channel(:B, true);
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.admin_resolve_report((SELECT id FROM public.admin_reports() LIMIT 1), 'disable');
SELECT pg_temp.ok('03a disable: every open report on him closed as disabled', NOT EXISTS (SELECT 1 FROM public.admin_reports())
  AND (SELECT count(*) FROM public.admin_reports(false) WHERE resolution = 'disabled') = 1);
RESET ROLE;
SELECT pg_temp.ok('03b his position is deleted, open channels to him closed',
  NOT EXISTS (SELECT 1 FROM private.user_locations WHERE user_id = :B) AND NOT EXISTS (SELECT 1 FROM public.walkie_contacts WHERE peer_id = :B));
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('03c Bob can do nothing any more (but still reads his own profile, to be told)',
  pg_temp.err(format('SELECT public.follow_user(%L)', :D)) = 'not_allowed'
  AND pg_temp.err('SELECT public.update_my_location(37.9, 23.7)') = 'not_allowed'
  AND (SELECT disabled FROM public.profiles WHERE id = :B));
RESET ROLE; SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('03d … and is gone for others: profile, search, lists, walkie list, sending to him',
  NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = :B)
  AND NOT EXISTS (SELECT 1 FROM public.search_users('bob'))
  AND NOT EXISTS (SELECT 1 FROM public.follow_list(:C, 'followers'))
  AND NOT EXISTS (SELECT 1 FROM public.walkie_list())
  AND pg_temp.fails(format($$SELECT public.send_walkie(%L, current_setting('app.b64'), 'audio/mp4', 1000)$$, :B)));
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.admin_set_disabled(:B, false);
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('03e re-enabled: works again (sharing must be turned on again for a position)',
  pg_temp.err(format('SELECT public.follow_user(%L)', :D)) = 'ok');
RESET ROLE;

-- 04 follower lists page through (offset) and leave blocked / disabled people out
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'f' || g || '@x', '{"age_confirmed":true,"full_name":"F"}'
FROM generate_series(1, 120) g;
INSERT INTO public.follows (follower_id, followee_id, created_at)
SELECT ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, :D, now() - make_interval(secs => g)
FROM generate_series(1, 120) g;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('04a 120 followers: pages of at most 100, newest first, no overlap, nothing missing',
  (SELECT count(*) FROM public.follow_list(:D, 'followers', 100, 0)) = 100
  AND (SELECT count(*) FROM public.follow_list(:D, 'followers', 100, 100)) = 21
  AND (SELECT count(*) FROM public.follow_list(:D, 'followers', 500, 0)) = 100
  AND (SELECT count(DISTINCT id) FROM (SELECT id FROM public.follow_list(:D, 'followers', 60, 0)
                                       UNION ALL SELECT id FROM public.follow_list(:D, 'followers', 60, 60)
                                       UNION ALL SELECT id FROM public.follow_list(:D, 'followers', 60, 120)) x) = 121
  AND (SELECT username FROM public.follow_list(:D, 'followers', 1, 0)) = 'bob');
SELECT public.block_user('00000000-0000-0000-0001-000000000001');
SELECT pg_temp.ok('04b someone you blocked is left out of other people''s lists', (SELECT count(*) FROM public.follow_list(:D, 'followers', 100, 100)) = 20);
SELECT pg_temp.ok('04c a bad list name returns nothing', NOT EXISTS (SELECT 1 FROM public.follow_list(:D, 'everyone')));
RESET ROLE;
SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT public.remove_follower('00000000-0000-0000-0001-000000000002');
SELECT pg_temp.ok('04d remove a follower', NOT EXISTS (SELECT 1 FROM public.follows WHERE follower_id = '00000000-0000-0000-0001-000000000002'));
RESET ROLE;
