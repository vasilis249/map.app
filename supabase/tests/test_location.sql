-- Live map: who may see whose location, the 200 m radius from your own position, reciprocity, expiry, blocks.
\set ON_ERROR_STOP 0
\set QUIET on
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'anna@x', '{"age_confirmed":true,"full_name":"Anna"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"age_confirmed":true,"full_name":"Bob"}'),
  ('00000000-0000-0000-0000-00000000000c', 'chris@x', '{"age_confirmed":true,"full_name":"Chris"}'),
  ('00000000-0000-0000-0000-00000000000d', 'dora@x', '{"age_confirmed":true,"full_name":"Dora"}'),
  ('00000000-0000-0000-0000-00000000000e', 'eva@x', '{"age_confirmed":true,"full_name":"Eva"}'),
  ('00000000-0000-0000-0000-00000000000f', 'fay@x', '{"age_confirmed":true,"full_name":"Fay"}'),
  ('00000000-0000-0000-0000-000000000010', 'gus@x', '{"age_confirmed":true,"full_name":"Gus"}'),
  ('00000000-0000-0000-0000-000000000011', 'hal@x', '{"age_confirmed":true,"full_name":"Hal"}'),
  ('00000000-0000-0000-0000-000000000012', 'ivy@x', '{"age_confirmed":true,"full_name":"Ivy"}');
-- Anna and Dora are friends (mutual follows).
INSERT INTO public.follows (follower_id, followee_id) VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000a');

CREATE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub', u, false);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false); END $$;
CREATE FUNCTION pg_temp.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '% %', CASE WHEN coalesce(cond, false) THEN 'PASS' ELSE 'FAIL' END, label; END $$;
CREATE FUNCTION pg_temp.fails(stmt text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN true; END $$;
-- Share with a mode and stand at (lat, lng) as that user.
CREATE FUNCTION pg_temp.put(u text, m text, la double precision, lo double precision) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.as_user(u);
  PERFORM public.set_location_sharing(m);
  IF m <> 'off' THEN PERFORM public.update_my_location(la, lo, 10); END IF;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, anon;

\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''
\set C '''00000000-0000-0000-0000-00000000000c'''
\set D '''00000000-0000-0000-0000-00000000000d'''
\set E '''00000000-0000-0000-0000-00000000000e'''
\set F '''00000000-0000-0000-0000-00000000000f'''
\set G '''00000000-0000-0000-0000-000000000010'''
\set H '''00000000-0000-0000-0000-000000000011'''
\set I '''00000000-0000-0000-0000-000000000012'''

-- 01 nothing direct
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('01a no direct access to positions or settings writes',
  pg_temp.fails('SELECT * FROM private.user_locations')
  AND pg_temp.fails(format($$INSERT INTO public.location_sharing (user_id, mode) VALUES (%L, 'everyone')$$, :A))
  AND pg_temp.fails($$SELECT private.are_nearby('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')$$));
SELECT pg_temp.ok('01b off by default; a position sent while off is ignored',
  (SELECT mode = 'off' AND NOT has_position FROM public.my_location_sharing())
  AND public.update_my_location(37.9838, 23.7275) = false
  AND (SELECT NOT has_position FROM public.my_location_sharing()));
SELECT pg_temp.ok('01c bad values refused', pg_temp.fails($$SELECT public.set_location_sharing('public')$$)
  AND pg_temp.fails($$SELECT public.set_location_sharing('everyone', 'strangers')$$));
RESET ROLE;

-- Anna at Syntagma; Bob ~100 m north; Chris ~2 km north; Dora (friend, friends-only) ~3 km away; Eva off nearby;
-- Fay nearby but blocked by Anna; Gus nearby with a 20 min old position; Hal next to Dora, sharing with everyone;
-- Ivy ~300 m north (inside Speak's old 500 m, outside this app's 200 m).
SET ROLE authenticated;
SELECT pg_temp.put(:A, 'everyone', 37.97550, 23.73480);
SELECT pg_temp.put(:B, 'everyone', 37.97640, 23.73480);
SELECT pg_temp.put(:C, 'everyone', 37.99350, 23.73480);
SELECT pg_temp.put(:D, 'friends', 38.00250, 23.73480);
SELECT pg_temp.put(:E, 'off', 37.97560, 23.73480);
SELECT pg_temp.put(:F, 'everyone', 37.97570, 23.73480);
SELECT pg_temp.put(:G, 'everyone', 37.97580, 23.73480);
SELECT pg_temp.put(:H, 'everyone', 38.00260, 23.73480);
SELECT pg_temp.put(:I, 'everyone', 37.97820, 23.73480);
SELECT pg_temp.as_user(:A); SELECT public.block_user(:F);
RESET ROLE;
UPDATE private.user_locations SET updated_at = now() - interval '20 minutes' WHERE user_id = :G;

-- 02 the map
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('02a nearby stranger (100 m) with exact position and distance',
  (SELECT distance_m BETWEEN 90 AND 110 AND lat = 37.97640 AND NOT is_friend AND can_talk FROM public.map_people() WHERE user_id = :B));
SELECT pg_temp.ok('02b a friend sharing with friends shows at any distance',
  EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :D AND is_friend AND distance_m > 2500));
SELECT pg_temp.ok('02c not: 2 km away, sharing off, blocked, stale (> 15 min)',
  NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id IN (:C, :E, :F, :G)));
SELECT pg_temp.ok('02d the radius never goes past 200 m (300 m and 2 km away: no, whatever the client asks)',
  NOT EXISTS (SELECT 1 FROM public.map_people(5000) WHERE user_id IN (:C, :I))
  AND NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :I)
  AND (SELECT count(*) FROM public.map_people(50)) = 1);
RESET ROLE; SELECT pg_temp.as_user(:H); SET ROLE authenticated;
SELECT pg_temp.ok('02e friends-only sharing is invisible to strangers next to you', NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :D));
RESET ROLE; SELECT pg_temp.as_user(:F); SET ROLE authenticated;
SELECT pg_temp.ok('02f the blocked one doesn''t see the blocker either', NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :A)
  AND EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :B));

-- 03 reciprocity
RESET ROLE; SELECT pg_temp.as_user(:E); SET ROLE authenticated;
SELECT pg_temp.ok('03a not sharing → you see nobody', NOT EXISTS (SELECT 1 FROM public.map_people()));
RESET ROLE; SELECT pg_temp.as_user(:G); SET ROLE authenticated;
SELECT pg_temp.ok('03b your own position stale → you see nobody', NOT EXISTS (SELECT 1 FROM public.map_people()));

-- 04 who may talk
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.set_location_sharing('everyone', 'nobody');
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('04a "nobody" → can_talk false', (SELECT NOT can_talk FROM public.map_people() WHERE user_id = :B));
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.set_location_sharing('everyone', 'following');
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('04b "following" → only people Bob follows', (SELECT NOT can_talk FROM public.map_people() WHERE user_id = :B));
RESET ROLE; INSERT INTO public.follows (follower_id, followee_id) VALUES (:B, :A);
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('04c … and once he follows Anna, she may talk', (SELECT can_talk FROM public.map_people() WHERE user_id = :B));
RESET ROLE;
SELECT pg_temp.ok('04d are_nearby: 100 m yes, 300 m no, 2 km no, blocked no, friends-only stranger no',
  private.are_nearby(:A, :B) AND NOT private.are_nearby(:A, :I) AND NOT private.are_nearby(:A, :C)
  AND NOT private.are_nearby(:A, :F) AND NOT private.are_nearby(:H, :D));

-- 05 writes, off, expiry
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.update_my_location(37.9, 23.7);
RESET ROLE;
SELECT pg_temp.ok('05a at most one stored position per second', (SELECT lat = 37.97550 FROM private.user_locations WHERE user_id = :A));
SELECT pg_sleep(1.1);
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.update_my_location(37.97551, 23.73480, -5, 400, 900);
RESET ROLE;
SELECT pg_temp.ok('05a2 … a second later it is stored; nonsense accuracy / heading / speed are dropped',
  (SELECT lat = 37.97551 AND accuracy_m IS NULL AND heading IS NULL AND speed IS NULL FROM private.user_locations WHERE user_id = :A));
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('05a3 out-of-range coordinates refused', pg_temp.fails('SELECT public.update_my_location(91, 0)')
  AND pg_temp.fails('SELECT public.update_my_location(0, 181)') AND pg_temp.fails($$SELECT public.update_my_location('NaN', 0)$$));
RESET ROLE;
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.set_location_sharing('off');
RESET ROLE;
SELECT pg_temp.ok('05b turning it off deletes your position', NOT EXISTS (SELECT 1 FROM private.user_locations WHERE user_id = :B));
UPDATE private.user_locations SET updated_at = now() - interval '2 hours' WHERE user_id = :C;
SELECT private.expire_locations();
SELECT pg_temp.ok('05c positions older than 1 h are deleted', NOT EXISTS (SELECT 1 FROM private.user_locations WHERE user_id = :C)
  AND EXISTS (SELECT 1 FROM private.user_locations WHERE user_id = :A));
DELETE FROM auth.users WHERE id = :H;
SELECT pg_temp.ok('05d account deletion removes position and settings',
  NOT EXISTS (SELECT 1 FROM private.user_locations WHERE user_id = :H) AND NOT EXISTS (SELECT 1 FROM public.location_sharing WHERE user_id = :H));
SET ROLE anon;
SELECT pg_temp.ok('05e anon: nothing', pg_temp.fails('SELECT * FROM public.map_people()') AND pg_temp.fails('SELECT * FROM public.location_sharing'));
RESET ROLE;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('06a your own settings return your own position (for the map)',
  (SELECT mode = 'everyone' AND round(lat::numeric, 4) = 37.9755 AND round(lng::numeric, 4) = 23.7348 FROM public.my_location_sharing()));
RESET ROLE;

-- 07 last seen: friends keep their last position on your map for up to 1 h, everyone else only 15 min
UPDATE private.user_locations SET updated_at = now() - interval '40 minutes' WHERE user_id = :D;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('07a a friend whose last update is 40 min old still shows (with its time), not talkable',
  (SELECT updated_at < now() - interval '39 minutes' AND NOT can_talk FROM public.map_people() WHERE user_id = :D));
RESET ROLE;
UPDATE private.user_locations SET updated_at = now() - interval '70 minutes' WHERE user_id = :D;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('07b … but not after an hour', NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :D));
RESET ROLE;
UPDATE private.user_locations SET updated_at = now() - interval '5 minutes' WHERE user_id = :D;
UPDATE public.location_sharing SET mode = 'everyone' WHERE user_id = :E;
INSERT INTO private.user_locations (user_id, lat, lng) VALUES (:E, 37.97560, 23.73480)
  ON CONFLICT (user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updated_at = now();
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('07c a stranger 10 m away with a fresh position shows', EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :E));
RESET ROLE;
UPDATE private.user_locations SET updated_at = now() - interval '20 minutes' WHERE user_id = :E;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('07d … not once their position is 20 min old', NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :E));
RESET ROLE;
UPDATE private.user_locations SET updated_at = now() WHERE user_id = :E;
UPDATE private.user_locations SET updated_at = now() - interval '30 minutes' WHERE user_id = :A;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('07e your own position 30 min old: your friend yes, strangers no',
  EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :D) AND NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :E));
RESET ROLE;

-- 08 the 200 m edge (measured on the server between stored positions; 0.0009° latitude ≈ 100.1 m)
UPDATE private.user_locations SET lat = 37.97550, lng = 23.73480, updated_at = now() WHERE user_id = :A;
INSERT INTO public.location_sharing (user_id, mode) VALUES (:B, 'everyone') ON CONFLICT (user_id) DO UPDATE SET mode = 'everyone';
INSERT INTO private.user_locations (user_id, lat, lng) VALUES (:B, 37.97550 + 195 / 111195.0, 23.73480)
  ON CONFLICT (user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updated_at = now();
UPDATE private.user_locations SET lat = 37.97550 + 205 / 111195.0, lng = 23.73480, updated_at = now() WHERE user_id = :E;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('08a 195 m: on the map and talkable; 205 m: not on the map',
  (SELECT distance_m BETWEEN 194 AND 196 AND can_talk FROM public.map_people() WHERE user_id = :B)
  AND NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :E));
RESET ROLE;
SELECT pg_temp.ok('08b are_nearby agrees (195 m yes, 205 m no)', private.are_nearby(:A, :B) AND NOT private.are_nearby(:A, :E));

-- 09 ghost mode: one tap off = position gone, invisible, and you see nobody; back on = visible after the next fix
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.set_location_sharing('off');
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('09a Bob in ghost mode: gone from Anna''s map at once', NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :B));
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('09b … his stored position is deleted and he sees nobody',
  (SELECT NOT has_position AND mode = 'off' FROM public.my_location_sharing()) AND NOT EXISTS (SELECT 1 FROM public.map_people()));
SELECT public.set_location_sharing('everyone');
SELECT pg_temp.ok('09c back on: still invisible until a new position arrives (no old one comes back)',
  (SELECT NOT has_position FROM public.my_location_sharing()));
SELECT public.update_my_location(37.97640, 23.73480, 8);
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('09d … and visible again with it', EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :B));
RESET ROLE;

-- 10 blocks hide both ways on the map even for friends sharing at any distance
SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT public.block_user(:A);
SELECT pg_temp.ok('10a a friend who blocks you: gone from your map and you from theirs, follows ended',
  NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :A));
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('10b … from your side too', NOT EXISTS (SELECT 1 FROM public.map_people() WHERE user_id = :D));
RESET ROLE;
