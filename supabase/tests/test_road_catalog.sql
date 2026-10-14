-- P7 road report catalog: details per kind, cameras, roadside help, lifetimes, other side, withdraw.
\set ON_ERROR_STOP 0
\set QUIET on
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'anna@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"age_confirmed":true}');

CREATE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub', u, false);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false); END $$;
CREATE FUNCTION pg_temp.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '% %', CASE WHEN coalesce(cond, false) THEN 'PASS' ELSE 'FAIL' END, label; END $$;
CREATE FUNCTION pg_temp.err(stmt text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE FUNCTION pg_temp.ttl(p uuid) RETURNS interval LANGUAGE sql AS $$
  SELECT expires_at - created_at FROM private.road_reports WHERE id = p $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, anon;

\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''
\set BOX '37.90, 23.60, 38.10, 23.90'

-- 01 details are checked per kind
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.cam', public.road_report('camera', 37.9800, 23.7300, 0, 'speed')::text, false);
SELECT set_config('app.pot', public.road_report('hazard', 37.9900, 23.7300, 0, 'pothole')::text, false);
SELECT set_config('app.fog', public.road_report('hazard', 38.0000, 23.7300, 0, 'fog')::text, false);
SELECT set_config('app.work', public.road_report('hazard', 38.0100, 23.7300, 0, 'roadwork')::text, false);
SELECT set_config('app.jam', public.road_report('traffic', 38.0200, 23.7300, 0, 'standstill')::text, false);
SELECT set_config('app.major', public.road_report('accident', 38.0300, 23.7300, 0, 'major')::text, false);
SELECT set_config('app.help', public.road_report('help', 38.0400, 23.7300, 0, 'tire')::text, false);
SELECT set_config('app.closed', public.road_report('closed', 38.0500, 23.7300)::text, false);
SELECT pg_temp.ok('01a every kind with a valid detail is stored, the detail comes back to the app',
  (SELECT count(*) = 8 FROM public.road_reports_in(:BOX))
  AND (SELECT sub = 'speed' AND kind = 'camera' FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.cam')::uuid)
  AND (SELECT sub IS NULL FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.closed')::uuid));
SELECT pg_temp.ok('01b a detail of another kind / unknown / on a kind without details is refused',
  pg_temp.err($$SELECT public.road_report('police', 37.9, 23.7, 0, 'pothole')$$) = 'bad_input'
  AND pg_temp.err($$SELECT public.road_report('hazard', 37.9, 23.7, 0, 'ufo')$$) = 'bad_input'
  AND pg_temp.err($$SELECT public.road_report('closed', 37.9, 23.7, 0, 'heavy')$$) = 'bad_input'
  AND pg_temp.err($$SELECT public.road_report('weather', 37.9, 23.7)$$) = 'bad_input');
SELECT pg_temp.ok('01c the old call without a detail still works (general report)',
  pg_temp.err($$SELECT public.road_report('police', 37.95, 23.65, 90)$$) = 'ok');
RESET ROLE;

-- 02 lifetimes
SELECT pg_temp.ok('02a camera 30 days, road works 1 day, fog 3 h, major accident 2 h, pothole 2 h, standstill 30 min, help 1 h, closed 6 h',
  pg_temp.ttl(current_setting('app.cam')::uuid) = interval '30 days'
  AND pg_temp.ttl(current_setting('app.work')::uuid) = interval '1 day'
  AND pg_temp.ttl(current_setting('app.fog')::uuid) = interval '3 hours'
  AND pg_temp.ttl(current_setting('app.major')::uuid) = interval '2 hours'
  AND pg_temp.ttl(current_setting('app.pot')::uuid) = interval '2 hours'
  AND pg_temp.ttl(current_setting('app.jam')::uuid) = interval '30 minutes'
  AND pg_temp.ttl(current_setting('app.help')::uuid) = interval '1 hour'
  AND pg_temp.ttl(current_setting('app.closed')::uuid) = interval '6 hours');

-- 03 confirmations
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT set_config('app.cam2', public.road_report('camera', 37.98025, 23.7300, 180, 'speed')::text, false);
SELECT set_config('app.cam3', public.road_report('camera', 37.9806, 23.7300, 0, 'speed')::text, false);
SELECT pg_temp.ok('03a a camera 28 m away is the same camera (+1); one 67 m away is another camera',
  current_setting('app.cam2') = current_setting('app.cam') AND current_setting('app.cam3') <> current_setting('app.cam')
  AND (SELECT up = 1 FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.cam')::uuid));
SELECT set_config('app.pol', public.road_report('police', 37.9200, 23.7000, 0)::text, false);
SELECT set_config('app.pol2', public.road_report('police', 37.9201, 23.7000, 0, 'hidden')::text, false);
SELECT pg_temp.ok('03b own report again nearby with a detail: the same report, now with the detail',
  current_setting('app.pol2') = current_setting('app.pol')
  AND (SELECT sub = 'hidden' FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.pol')::uuid));
SELECT set_config('app.pol3', public.road_report('police', 37.9201, 23.7001, 0, 'other_side')::text, false);
SELECT pg_temp.ok('03c police on the other side is its own report (not a confirmation of this side)',
  current_setting('app.pol3') <> current_setting('app.pol'));
RESET ROLE;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.pol4', public.road_report('police', 37.9202, 23.7001, 0, 'other_side')::text, false);
SELECT pg_temp.ok('03d … and another other-side report there confirms it',
  current_setting('app.pol4') = current_setting('app.pol3')
  AND (SELECT up = 1 FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.pol3')::uuid));

-- 04 a "still there" on a camera keeps it for at least 15 more days
RESET ROLE;
UPDATE private.road_reports SET expires_at = now() + interval '1 day' WHERE id = current_setting('app.cam3')::uuid;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.road_vote(current_setting('app.cam3')::uuid, 1);
RESET ROLE;
SELECT pg_temp.ok('04a +1 on a camera: ≥ 15 days from now',
  (SELECT expires_at > now() + interval '14 days 23 hours' FROM private.road_reports WHERE id = current_setting('app.cam3')::uuid));

-- 05 withdraw your own
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.road_withdraw(current_setting('app.help')::uuid);
SELECT pg_temp.ok('05a help arrived: withdrawn, gone from the map',
  NOT EXISTS (SELECT 1 FROM public.road_reports_in(:BOX) WHERE id = current_setting('app.help')::uuid));
SELECT pg_temp.ok('05b someone else''s report can''t be withdrawn; twice neither',
  pg_temp.err(format('SELECT public.road_withdraw(%L)', current_setting('app.pol'))) = 'not_found'
  AND pg_temp.err(format('SELECT public.road_withdraw(%L)', current_setting('app.help'))) = 'not_found');
RESET ROLE;
SELECT pg_temp.ok('05c no strike for withdrawing your own',
  NOT EXISTS (SELECT 1 FROM private.road_strikes WHERE user_id = :A));

-- 06 access
SET ROLE anon;
SELECT pg_temp.ok('06a anon can''t report / withdraw / read',
  pg_temp.err($$SELECT public.road_report('camera', 37.9, 23.7, 0, 'speed')$$) LIKE 'permission denied%'
  AND pg_temp.err(format('SELECT public.road_withdraw(%L)', current_setting('app.pol'))) LIKE 'permission denied%'
  AND pg_temp.err($$SELECT * FROM public.road_reports_in(37.9, 23.6, 38.1, 23.9)$$) LIKE 'permission denied%');
RESET ROLE;
SELECT pg_temp.ok('06b the private helpers are not callable by users',
  NOT has_function_privilege('authenticated', 'private.road_sub_ok(text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'private.road_ttl(text, text)', 'EXECUTE'));
