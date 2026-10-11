-- Live map, push to talk: who may knock whom, the pair channel, answers, saved transmissions, limits, blocks.
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
-- Anna and Gus are friends (mutual follows).
INSERT INTO public.follows (follower_id, followee_id) VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000010'),
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-00000000000a');

CREATE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub', u, false);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false); END $$;
CREATE FUNCTION pg_temp.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '% %', CASE WHEN coalesce(cond, false) THEN 'PASS' ELSE 'FAIL' END, label; END $$;
CREATE FUNCTION pg_temp.fails(stmt text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN true; END $$;
CREATE FUNCTION pg_temp.err(stmt text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE FUNCTION pg_temp.put(u text, m text, la double precision, lo double precision, talk text DEFAULT 'everyone')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.as_user(u);
  PERFORM public.set_location_sharing(m, talk);
  IF m <> 'off' THEN PERFORM public.update_my_location(la, lo, 10); END IF;
END $$;
-- Realtime's check: can the current user SELECT (join/receive) / INSERT (send) on this topic?
CREATE FUNCTION pg_temp.rt(p_topic text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE pid bigint; r boolean; w boolean := true;
BEGIN
  PERFORM set_config('realtime.topic', p_topic, true);
  pid := realtime.probe(p_topic);
  SELECT EXISTS (SELECT 1 FROM realtime.messages WHERE id = pid) INTO r;
  BEGIN
    INSERT INTO realtime.messages (topic, extension, private) VALUES (p_topic, 'broadcast', true);
  EXCEPTION WHEN OTHERS THEN w := false; END;
  RETURN CASE WHEN r THEN 'r' ELSE '-' END || CASE WHEN w THEN 'w' ELSE '-' END;
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
\set AB '''nearby:00000000-0000-0000-0000-00000000000a:00000000-0000-0000-0000-00000000000b'''
\set BA '''nearby:00000000-0000-0000-0000-00000000000b:00000000-0000-0000-0000-00000000000a'''
\set AC '''nearby:00000000-0000-0000-0000-00000000000a:00000000-0000-0000-0000-00000000000c'''
\set AD '''nearby:00000000-0000-0000-0000-00000000000a:00000000-0000-0000-0000-00000000000d'''
SELECT set_config('app.b64', encode(convert_to(repeat('voice', 60), 'UTF8'), 'base64'), false);

-- Anna at Syntagma; ~100 m north: Bob (anyone may talk), Chris (nobody may talk), Eva (friends-only sharing),
-- Fay (only people she follows), Hal (blocked by Anna), Ivy; Dora 2 km away; Gus (Anna's friend) 3 km away.
SET ROLE authenticated;
SELECT pg_temp.put(:A, 'everyone', 37.97550, 23.73480);
SELECT pg_temp.put(:B, 'everyone', 37.97640, 23.73480);
SELECT pg_temp.put(:C, 'everyone', 37.97640, 23.73490, 'nobody');
SELECT pg_temp.put(:D, 'everyone', 37.99350, 23.73480);
SELECT pg_temp.put(:E, 'friends', 37.97640, 23.73500);
SELECT pg_temp.put(:F, 'everyone', 37.97640, 23.73510, 'following');
SELECT pg_temp.put(:G, 'friends', 38.00250, 23.73480);
SELECT pg_temp.put(:H, 'everyone', 37.97640, 23.73520);
SELECT pg_temp.put(:I, 'everyone', 37.97640, 23.73530);
SELECT pg_temp.as_user(:A); SELECT public.block_user(:H);
RESET ROLE;

-- 01 knocks
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('01a no direct access to knocks, audio or other people''s transmissions',
  pg_temp.fails('SELECT * FROM private.nearby_knocks') AND pg_temp.fails('SELECT * FROM private.nearby_audio')
  AND pg_temp.fails(format($$INSERT INTO public.nearby_messages (sender_id, recipient_id, duration_ms) VALUES (%L, %L, 1000)$$, :A, :B))
  AND pg_temp.fails(format($$SELECT private.may_talk_nearby(%L, %L)$$, :A, :B)));
SELECT pg_temp.ok('01b Anna may knock Bob (100 m, anyone may talk)', pg_temp.err(format('SELECT public.nearby_knock(%L)', :B)) = 'ok');
RESET ROLE;
SELECT pg_temp.ok('01c … and Bob''s inbox gets who and how far (server side, private topic)',
  EXISTS (SELECT 1 FROM realtime.messages WHERE topic = 'nearby-in:' || :B AND event = 'knock' AND private
          AND payload->>'from' = :A AND payload->>'full_name' = 'Anna' AND (payload->>'distance_m')::int BETWEEN 90 AND 110));
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('01d not: "nobody", 2 km, friends-only stranger, "following" without the follow, blocked, a friend 3 km away, yourself',
  pg_temp.err(format('SELECT public.nearby_knock(%L)', :C)) = 'not_nearby'
  AND pg_temp.err(format('SELECT public.nearby_knock(%L)', :D)) = 'not_nearby'
  AND pg_temp.err(format('SELECT public.nearby_knock(%L)', :E)) = 'not_nearby'
  AND pg_temp.err(format('SELECT public.nearby_knock(%L)', :F)) = 'not_nearby'
  AND pg_temp.err(format('SELECT public.nearby_knock(%L)', :H)) = 'not_nearby'
  AND pg_temp.err(format('SELECT public.nearby_knock(%L)', :G)) = 'not_nearby'
  AND pg_temp.err(format('SELECT public.nearby_knock(%L)', :A)) = 'not_nearby');
RESET ROLE; INSERT INTO public.follows (follower_id, followee_id) VALUES (:F, :A);
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('01e once Fay follows Anna, Anna may talk to her', pg_temp.err(format('SELECT public.nearby_knock(%L)', :F)) = 'ok');
RESET ROLE; SELECT pg_temp.as_user(:H); SET ROLE authenticated;
SELECT pg_temp.ok('01f the blocked one can''t knock the blocker', pg_temp.err(format('SELECT public.nearby_knock(%L)', :A)) = 'not_nearby');

-- 02 answers: Chris ("nobody") talks to Anna → Anna may answer him for 5 minutes
RESET ROLE; SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('02a Chris may talk to Anna (her setting lets everyone in)', pg_temp.err(format('SELECT public.nearby_knock(%L)', :A)) = 'ok');
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('02b … so Anna may answer Chris, and the map says so',
  pg_temp.err(format('SELECT public.nearby_knock(%L)', :C)) = 'ok'
  AND (SELECT can_talk FROM public.map_people() WHERE user_id = :C));
RESET ROLE; UPDATE private.nearby_knocks SET created_at = now() - interval '6 minutes' WHERE sender_id = :C;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('02c after 5 minutes the answer window closes',
  pg_temp.err(format('SELECT public.nearby_knock(%L)', :C)) = 'not_nearby'
  AND (SELECT NOT can_talk FROM public.map_people() WHERE user_id = :C));
SELECT pg_temp.ok('02d a friend 3 km away is on the map but can''t be talked to',
  (SELECT is_friend AND NOT can_talk FROM public.map_people() WHERE user_id = :G));

-- 03 the pair channel and the inbox
SELECT pg_temp.ok('03a Anna and Bob: both read + write on their canonical topic, nothing on the reversed name',
  pg_temp.rt(:AB) = 'rw' AND pg_temp.rt(:BA) = '--');
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('03b Bob too', pg_temp.rt(:AB) = 'rw');
RESET ROLE; SELECT pg_temp.as_user(:I); SET ROLE authenticated;
SELECT pg_temp.ok('03c a third person nearby: nothing on their topic, nothing in Anna''s inbox',
  pg_temp.rt(:AB) = '--' AND pg_temp.rt('nearby-in:' || :A) = '--');
RESET ROLE; SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('03d your inbox: you listen, nobody writes (not even you)', pg_temp.rt('nearby-in:' || :A) = 'r-');
SELECT pg_temp.ok('03e 2 km away and no knock: no pair channel', pg_temp.rt(:AD) = '--');
RESET ROLE;
UPDATE private.nearby_knocks SET created_at = now() - interval '6 minutes' WHERE sender_id = :A AND recipient_id = :C;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('03f Chris ("nobody") may still talk to Anna, so their channel stays (only her knocks are refused, 02c)',
  pg_temp.rt(:AC) = 'rw');
-- Bob walks 2 km away: the knock still keeps the conversation for 5 minutes, then it closes.
RESET ROLE; UPDATE private.user_locations SET lat = 37.99400 WHERE user_id = :B;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('03g moved apart, knock < 5 min: still open', pg_temp.rt(:AB) = 'rw');
RESET ROLE; UPDATE private.nearby_knocks SET created_at = now() - interval '6 minutes' WHERE sender_id = :A AND recipient_id = :B;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('03h … and closed after that', pg_temp.rt(:AB) = '--'
  AND pg_temp.err(format('SELECT public.nearby_knock(%L)', :B)) = 'not_nearby');
RESET ROLE;
UPDATE private.user_locations SET lat = 37.97640, updated_at = now() WHERE user_id = :B;

-- 04 saved transmissions
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.nearby_knock(:B);
SELECT pg_temp.ok('04a save after a knock', pg_temp.err(format('SELECT public.send_nearby(%L, %L, ''audio/mp4'', 2500)', :B, current_setting('app.b64'))) = 'ok');
SELECT pg_temp.ok('04b no save without a knock (Ivy)', pg_temp.err(format('SELECT public.send_nearby(%L, %L, ''audio/mp4'', 2500)', :I, current_setting('app.b64'))) = 'not_nearby');
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('04c Bob: history, replay, a "nearby" notice from Anna',
  (SELECT count(*) = 1 FROM public.nearby_history(:A))
  AND (SELECT mime = 'audio/mp4' AND length(audio_b64) > 100 FROM public.nearby_audio((SELECT id FROM public.nearby_history(:A) LIMIT 1)))
  AND EXISTS (SELECT 1 FROM public.notifications WHERE kind = 'nearby' AND actor_id = :A));
RESET ROLE; SELECT pg_temp.as_user(:I); SET ROLE authenticated;
SELECT pg_temp.ok('04d someone else: no rows, no audio',
  NOT EXISTS (SELECT 1 FROM public.nearby_messages)
  AND NOT EXISTS (SELECT 1 FROM public.nearby_audio((SELECT id FROM public.nearby_messages LIMIT 1))));
RESET ROLE;

-- 05 limits: 30 different people an hour
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'p' || g || '@x', '{"age_confirmed":true,"full_name":"P"}'
FROM generate_series(1, 30) g;
INSERT INTO private.nearby_knocks (sender_id, recipient_id, created_at)
SELECT :A, ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, now() - interval '10 minutes'
FROM generate_series(1, 30) g;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('05a a 31st different person in an hour: too_many_people',
  pg_temp.err(format('SELECT public.nearby_knock(%L)', :I)) = 'too_many_people');
SELECT pg_temp.ok('05b someone you already talked to this hour: still fine', pg_temp.err(format('SELECT public.nearby_knock(%L)', :B)) = 'ok');
RESET ROLE;
DELETE FROM private.nearby_knocks WHERE recipient_id::text LIKE '00000000-0000-0000-0001-%';

-- 06 block
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.block_user(:A);
RESET ROLE;
SELECT pg_temp.ok('06a blocking wipes the pair''s transmissions and knocks',
  NOT EXISTS (SELECT 1 FROM public.nearby_messages WHERE :A IN (sender_id, recipient_id) AND :B IN (sender_id, recipient_id))
  AND NOT EXISTS (SELECT 1 FROM private.nearby_knocks WHERE :A IN (sender_id, recipient_id) AND :B IN (sender_id, recipient_id)));
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('06b … and closes the channel', pg_temp.rt(:AB) = '--' AND pg_temp.err(format('SELECT public.nearby_knock(%L)', :B)) = 'not_nearby');

-- 07 expiry, anon
SELECT public.nearby_knock(:I);
SELECT public.send_nearby(:I, current_setting('app.b64'), 'audio/mp4', 1200);
RESET ROLE;
UPDATE public.nearby_messages SET created_at = now() - interval '25 hours';
UPDATE private.nearby_knocks SET created_at = now() - interval '2 hours';
SELECT private.expire_nearby();
SELECT pg_temp.ok('07a transmissions go after 24 h, knocks after 1 h',
  NOT EXISTS (SELECT 1 FROM public.nearby_messages) AND NOT EXISTS (SELECT 1 FROM private.nearby_audio)
  AND NOT EXISTS (SELECT 1 FROM private.nearby_knocks));
SET ROLE anon;
SELECT pg_temp.ok('07b anon: nothing', pg_temp.fails(format('SELECT public.nearby_knock(%L)', :B))
  AND pg_temp.fails('SELECT * FROM public.nearby_messages'));
RESET ROLE;
