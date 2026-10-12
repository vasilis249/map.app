-- Road reports (Waze-style): create, confirm instead of duplicate, votes, expiry, anonymity, blocks, abuse, privacy.
\set ON_ERROR_STOP 0
\set QUIET on
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'anna@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000c', 'chris@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000d', 'dora@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000e', 'eve@x', '{"age_confirmed":true}');
INSERT INTO private.admins (user_id) VALUES ('00000000-0000-0000-0000-00000000000e');

CREATE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub', u, false);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false); END $$;
CREATE FUNCTION pg_temp.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '% %', CASE WHEN coalesce(cond, false) THEN 'PASS' ELSE 'FAIL' END, label; END $$;
CREATE FUNCTION pg_temp.err(stmt text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, anon;

\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''
\set C '''00000000-0000-0000-0000-00000000000c'''
\set D '''00000000-0000-0000-0000-00000000000d'''
\set E '''00000000-0000-0000-0000-00000000000e'''
-- Syntagma; a box around it
\set BOX '37.96, 23.72, 37.99, 23.75'

-- 01 create
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.p1', public.road_report('police', 37.9755, 23.7348, 90)::text, false);
SELECT pg_temp.ok('01a police reported at your position, with your direction',
  (SELECT kind = 'police' AND mine AND heading = 90 AND up = 0 FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.p1')::uuid));
SELECT pg_temp.ok('01b bad kind / coordinates refused',
  pg_temp.err($$SELECT public.road_report('ufo', 37.9, 23.7)$$) = 'bad_input'
  AND pg_temp.err($$SELECT public.road_report('police', 95, 23.7)$$) = 'bad_input'
  AND pg_temp.err($$SELECT public.road_report('police', 'NaN', 23.7)$$) = 'bad_input');
SELECT pg_temp.ok('01c the table itself is not readable (only through the RPC)',
  pg_temp.err('SELECT * FROM private.road_reports') LIKE 'permission denied%');
RESET ROLE;

-- 02 anonymity: others see it, never who made it
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('02a Bob sees it, not as his, and the result has no author column',
  (SELECT NOT mine FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.p1')::uuid)
  AND (SELECT NOT ('created_by' = ANY (proargnames)) FROM pg_proc WHERE proname = 'road_reports_in'));
-- 03 the same kind within 100 m = a confirmation, not a second report
SELECT set_config('app.p2', public.road_report('police', 37.9757, 23.7349)::text, false);
SELECT pg_temp.ok('03a Bob reporting police 25 m away confirms Anna''s report (same id, +1)',
  current_setting('app.p2') = current_setting('app.p1')
  AND (SELECT up = 1 AND voted = 1 FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.p1')::uuid));
SELECT set_config('app.h1', public.road_report('hazard', 37.9757, 23.7349)::text, false);
SELECT pg_temp.ok('03b another kind at the same place is its own report',
  current_setting('app.h1') <> current_setting('app.p1') AND (SELECT count(*) FROM public.road_reports_in(:BOX)) = 2);
RESET ROLE;

-- 04 votes
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('04a no vote on your own report', pg_temp.err(format('SELECT public.road_vote(%L, 1)', current_setting('app.p1'))) = 'own_report');
RESET ROLE;
UPDATE private.road_reports SET expires_at = now() + interval '5 minutes' WHERE id = current_setting('app.p1')::uuid;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.road_vote(current_setting('app.p1')::uuid, 1);
RESET ROLE;
SELECT pg_temp.ok('04b "still there" extends it (≥ half its time from now: police 30 min)',
  (SELECT expires_at > now() + interval '29 minutes' AND up = 2 FROM private.road_reports WHERE id = current_setting('app.p1')::uuid));
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.road_vote(current_setting('app.p1')::uuid, -1);
RESET ROLE;
SELECT pg_temp.ok('04c you can change your vote (one vote each)',
  (SELECT up = 1 AND down = 1 FROM private.road_reports WHERE id = current_setting('app.p1')::uuid)
  AND (SELECT count(*) FROM private.road_votes WHERE report_id = current_setting('app.p1')::uuid) = 2);
SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT public.road_vote(current_setting('app.h1')::uuid, -1);
RESET ROLE;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.road_vote(current_setting('app.h1')::uuid, -1);
RESET ROLE;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('04d two "not there" (no "still there"): the hazard is gone from the map',
  NOT EXISTS (SELECT 1 FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.h1')::uuid));
SELECT pg_temp.ok('04e … and voting on it now: not_found', pg_temp.err(format('SELECT public.road_vote(%L, 1)', current_setting('app.h1'))) = 'not_found');
RESET ROLE;
SELECT pg_temp.ok('04f its author (Bob) got a strike — without place or time of day',
  (SELECT count(*) FROM private.road_strikes WHERE user_id = :B) = 1
  AND (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns
       WHERE table_schema = 'private' AND table_name = 'road_strikes') = ARRAY['at', 'user_id']);

-- 05 expiry
UPDATE private.road_reports SET expires_at = now() - interval '1 minute' WHERE id = current_setting('app.p1')::uuid;
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('05a expired: off the map at once', NOT EXISTS (SELECT 1 FROM public.road_reports_in(:BOX)));
RESET ROLE;
SELECT private.expire_road();
SELECT pg_temp.ok('05b … kept a day (for abuse reports), then deleted with its votes (no position history)',
  EXISTS (SELECT 1 FROM private.road_reports WHERE id = current_setting('app.p1')::uuid));
UPDATE private.road_reports SET expires_at = now() - interval '25 hours', removed_at = coalesce(removed_at, now() - interval '25 hours');
SELECT private.expire_road();
SELECT pg_temp.ok('05c … deleted', NOT EXISTS (SELECT 1 FROM private.road_reports) AND NOT EXISTS (SELECT 1 FROM private.road_votes));

-- 06 blocks and disabled accounts
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.t1', public.road_report('traffic', 37.9760, 23.7350)::text, false);
RESET ROLE;
SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT public.block_user(:A);
SELECT pg_temp.ok('06a Dora blocked Anna: Anna''s reports are not on Dora''s map, and she can''t vote on them',
  NOT EXISTS (SELECT 1 FROM public.road_reports_in(:BOX))
  AND pg_temp.err(format('SELECT public.road_vote(%L, 1)', current_setting('app.t1'))) = 'not_found');
SELECT set_config('app.t2', public.road_report('traffic', 37.9760, 23.7350)::text, false);
SELECT pg_temp.ok('06b … and Dora''s own traffic report there is a new one (not a confirmation of Anna''s)',
  current_setting('app.t2') <> current_setting('app.t1'));
RESET ROLE;
UPDATE public.profiles SET disabled = true WHERE id = :A;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('06c a disabled account''s reports vanish', NOT EXISTS (SELECT 1 FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.t1')::uuid));
RESET ROLE;
UPDATE public.profiles SET disabled = false WHERE id = :A;

-- 07 abuse: report it, a moderator removes it
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('07a anyone can report a road report as abuse (fake, a trap…)',
  pg_temp.err(format('SELECT public.report_content(%L, %L, %L)', 'road', current_setting('app.t1'), 'fake')) = 'ok');
RESET ROLE;
SELECT pg_temp.ok('07b … in the queue as kind road, against Anna',
  (SELECT count(*) FROM public.reports WHERE kind = 'road' AND target_user_id = :A AND target_id = current_setting('app.t1')::uuid) = 1);
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('07c only admins remove road reports', pg_temp.err(format('SELECT public.admin_remove_road_report(%L)', current_setting('app.t1'))) = 'not_allowed');
RESET ROLE;
SELECT pg_temp.as_user(:E); SET ROLE authenticated;
SELECT pg_temp.ok('07d the admin queue shows what was reported (kind traffic)',
  (SELECT road_kind = 'traffic' FROM public.admin_reports(true) WHERE kind = 'road'));
SELECT public.admin_remove_road_report(current_setting('app.t1')::uuid);
SELECT pg_temp.ok('07e removed: off the map, abuse report closed as removed, a strike for Anna',
  NOT EXISTS (SELECT 1 FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.t1')::uuid)
  AND NOT EXISTS (SELECT 1 FROM public.admin_reports(true) WHERE kind = 'road'));
RESET ROLE;
SELECT pg_temp.ok('07f … recorded', (SELECT resolution = 'removed' AND resolved_by = :E FROM public.reports WHERE kind = 'road')
  AND (SELECT count(*) FROM private.road_strikes WHERE user_id = :A) = 1);

-- 08 too many strikes / rate limits / box size
INSERT INTO private.road_strikes (user_id) SELECT :A FROM generate_series(1, 4);
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('08a five reports removed in a week: no more reports for now',
  pg_temp.err($$SELECT public.road_report('police', 37.9, 23.7)$$) = 'too_many_strikes');
RESET ROLE;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT set_config('app.r', (SELECT string_agg(pg_temp.err(format('SELECT public.road_report(%L, %s, 23.70)', 'hazard', 37.90 + i * 0.01)), ',') FROM generate_series(1, 11) i), false);
SELECT pg_temp.ok('08b at most 10 reports in 10 minutes (' || current_setting('app.r') || ')',
  current_setting('app.r') LIKE '%rate_limited' AND current_setting('app.r') NOT LIKE '%rate_limited%,%');
SELECT pg_temp.ok('08c a huge box is refused (no dumping the whole country''s reports)',
  pg_temp.err('SELECT * FROM public.road_reports_in(30, 10, 40, 30)') = 'bad_input');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('08d not signed in: nothing', pg_temp.err('SELECT * FROM public.road_reports_in(37.96, 23.72, 37.99, 23.75)') LIKE 'permission denied%');
RESET ROLE;
SELECT pg_temp.ok('08e every road RPC is SECURITY DEFINER with an empty search_path',
  (SELECT bool_and(prosecdef AND proconfig @> ARRAY['search_path=""']) FROM pg_proc
   WHERE proname IN ('road_report', 'road_vote', 'road_reports_in', 'admin_remove_road_report', 'road_remove', 'expire_road')));
