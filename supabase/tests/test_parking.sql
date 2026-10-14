-- P7 parking spots: free (green) when leaving, taken (red) when parking, green → red, anonymity, blocks, expiry, limits.
\set ON_ERROR_STOP 0
\set QUIET on
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'anna@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000c', 'chris@x', '{"age_confirmed":true}');

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
\set BOX '37.96, 23.72, 37.99, 23.75'

-- 01 Anna leaves her spot: green for 15 min
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.s1', public.parking_leave(37.9700, 23.7300)::text, false);
SELECT pg_temp.ok('01a leaving: a free spot, hers, ~15 min',
  (SELECT state = 'free' AND mine AND expires_at BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes'
   FROM public.parking_in(:BOX) WHERE id = current_setting('app.s1')::uuid));
SELECT set_config('app.s1b', public.parking_leave(37.97005, 23.7300)::text, false);
SELECT pg_temp.ok('01b leaving again 5 m away refreshes the same spot (no duplicate)',
  current_setting('app.s1b') = current_setting('app.s1') AND (SELECT count(*) FROM public.parking_in(:BOX)) = 1);
SELECT pg_temp.ok('01c bad coordinates refused; the table is not readable directly',
  pg_temp.err($$SELECT public.parking_leave(95, 23.7)$$) = 'bad_input'
  AND pg_temp.err($$SELECT public.parking_park(NULL, 23.7)$$) = 'bad_input'
  AND pg_temp.err('SELECT * FROM private.parking_spots') LIKE 'permission denied%');
RESET ROLE;

-- 02 Bob sees it (not his, no author); parks on it → red for everyone
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('02a Bob sees the green spot, not as his; no author column',
  (SELECT state = 'free' AND NOT mine FROM public.parking_in(:BOX) WHERE id = current_setting('app.s1')::uuid)
  AND (SELECT NOT ('created_by' = ANY (proargnames)) FROM pg_proc WHERE proname = 'parking_in'));
SELECT set_config('app.s2', public.parking_park(37.97008, 23.73003)::text, false);
SELECT pg_temp.ok('02b parking 10 m from it takes that spot: the same id, now red, ~10 min',
  current_setting('app.s2') = current_setting('app.s1')
  AND (SELECT state = 'taken' AND expires_at < now() + interval '11 minutes' FROM public.parking_in(:BOX) WHERE id = current_setting('app.s1')::uuid));
SELECT set_config('app.s3', public.parking_park(37.9750, 23.7400)::text, false);
SELECT pg_temp.ok('02c parking where nothing was marked: a red spot of its own',
  current_setting('app.s3') <> current_setting('app.s1')
  AND (SELECT state = 'taken' AND mine FROM public.parking_in(:BOX) WHERE id = current_setting('app.s3')::uuid));
-- Bob leaves later from where he parked: his red one goes, a green one appears
SELECT set_config('app.s4', public.parking_leave(37.9750, 23.7400)::text, false);
SELECT pg_temp.ok('02d leaving from where he parked: his red spot is gone, a green one there',
  NOT EXISTS (SELECT 1 FROM public.parking_in(:BOX) WHERE id = current_setting('app.s3')::uuid)
  AND (SELECT state = 'free' FROM public.parking_in(:BOX) WHERE id = current_setting('app.s4')::uuid));
RESET ROLE;

-- 03 "taken" by someone who saw it
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.parking_taken(current_setting('app.s4')::uuid);
SELECT pg_temp.ok('03a Chris marks the green spot taken: red',
  (SELECT state = 'taken' FROM public.parking_in(:BOX) WHERE id = current_setting('app.s4')::uuid));
SELECT pg_temp.ok('03b a red / unknown spot can''t be "taken" again',
  pg_temp.err(format('SELECT public.parking_taken(%L)', current_setting('app.s4'))) = 'not_found'
  AND pg_temp.err(format('SELECT public.parking_taken(%L)', gen_random_uuid())) = 'not_found');
SELECT pg_temp.ok('03c boxes larger than 0.5° refused', pg_temp.err($$SELECT * FROM public.parking_in(37, 23, 38, 24)$$) = 'bad_input');
RESET ROLE;

-- 04 blocks: Chris blocks Anna → neither sees the other's spots
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.s5', public.parking_leave(37.9800, 23.7450)::text, false);
RESET ROLE;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.block_user(:A);
SELECT pg_temp.ok('04a after a block, Anna''s spot is hidden from Chris and he can''t mark it',
  NOT EXISTS (SELECT 1 FROM public.parking_in(:BOX) WHERE id = current_setting('app.s5')::uuid)
  AND pg_temp.err(format('SELECT public.parking_taken(%L)', current_setting('app.s5'))) = 'not_found');
SELECT set_config('app.s6', public.parking_park(37.98005, 23.7450)::text, false);
SELECT pg_temp.ok('04b … and parking next to it doesn''t take it (his own red spot instead)',
  current_setting('app.s6') <> current_setting('app.s5'));
RESET ROLE;

-- 05 disabled authors hidden; expiry + deletion
UPDATE public.profiles SET disabled = true WHERE id = :B;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('05a a disabled account''s spots are hidden',
  NOT EXISTS (SELECT 1 FROM public.parking_in(:BOX) WHERE id = current_setting('app.s4')::uuid));
RESET ROLE;
UPDATE public.profiles SET disabled = false WHERE id = :B;
UPDATE private.parking_spots SET expires_at = now() - interval '2 minutes' WHERE id = current_setting('app.s5')::uuid;
UPDATE private.parking_spots SET expires_at = now() - interval '2 hours' WHERE id = current_setting('app.s6')::uuid;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('05b an expired spot is no longer shown',
  NOT EXISTS (SELECT 1 FROM public.parking_in(:BOX) WHERE id = current_setting('app.s5')::uuid));
RESET ROLE;
SELECT private.expire_parking();
SELECT pg_temp.ok('05c cleanup deletes spots expired over an hour ago, keeps the recent ones',
  NOT EXISTS (SELECT 1 FROM private.parking_spots WHERE id = current_setting('app.s6')::uuid)
  AND EXISTS (SELECT 1 FROM private.parking_spots WHERE id = current_setting('app.s5')::uuid));

-- 06 limits and access
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('06a 20 marks in 10 minutes, then rate_limited',
  (SELECT bool_and(pg_temp.err(format('SELECT public.parking_leave(%s, 23.70)', 37.90 + g * 0.001)) = 'ok') FROM generate_series(1, 19) g)  -- (+ his one mark above = 20)
  AND pg_temp.err($$SELECT public.parking_leave(37.95, 23.70)$$) = 'rate_limited');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('06b anon can''t mark or read',
  pg_temp.err($$SELECT public.parking_leave(37.9, 23.7)$$) LIKE 'permission denied%'
  AND pg_temp.err($$SELECT * FROM public.parking_in(37.96, 23.72, 37.99, 23.75)$$) LIKE 'permission denied%');
RESET ROLE;
SELECT pg_temp.ok('06c helpers not callable by users',
  NOT has_function_privilege('authenticated', 'private.parking_near(uuid, text, double precision, double precision, double precision)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'private.expire_parking()', 'EXECUTE'));
DELETE FROM auth.users WHERE id = :A;
SELECT pg_temp.ok('06d deleting an account deletes its spots', NOT EXISTS (SELECT 1 FROM private.parking_spots WHERE created_by = :A));
