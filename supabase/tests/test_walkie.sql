-- Walkie-talkie: who may join / send on a live channel, saving and replaying transmissions for 24 h.
\set ON_ERROR_STOP 0
\set QUIET on
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'anna@x', '{"full_name":"Anna"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"full_name":"Bob"}'),
  ('00000000-0000-0000-0000-00000000000c', 'chris@x', '{"full_name":"Chris"}');
-- Anna and Bob are friends (mutual follows); Chris only follows Anna.
INSERT INTO public.follows (follower_id, followee_id) VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000a');

CREATE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub', u, false);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false); END $$;
CREATE FUNCTION pg_temp.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '% %', CASE WHEN coalesce(cond, false) THEN 'PASS' ELSE 'FAIL' END, label; END $$;
CREATE FUNCTION pg_temp.fails(stmt text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN true; END $$;
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
\set AB '''walkie:00000000-0000-0000-0000-00000000000a:00000000-0000-0000-0000-00000000000b'''
\set BA '''walkie:00000000-0000-0000-0000-00000000000b:00000000-0000-0000-0000-00000000000a'''
\set AC '''walkie:00000000-0000-0000-0000-00000000000a:00000000-0000-0000-0000-00000000000c'''
SELECT set_config('app.b64', encode(convert_to(repeat('voice', 60), 'UTF8'), 'base64'), false);

-- 01 live channel authorization
SELECT pg_temp.ok('01a topic name is canonical', private.walkie_topic(:B, :A) = :AB);
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('01b a friend may join and send', pg_temp.rt(:AB) = 'rw');
SELECT pg_temp.ok('01c nothing on the reversed name', pg_temp.rt(:BA) = '--');
SELECT pg_temp.ok('01d not with a one-way follower', pg_temp.rt(:AC) = '--');
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('01e the other friend too', pg_temp.rt(:AB) = 'rw');
RESET ROLE; SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('01f an outsider can neither listen nor send', pg_temp.rt(:AB) = '--');
SELECT pg_temp.ok('01g any other private topic is refused (no catch-all policy)',
  pg_temp.rt('notes:00000000-0000-0000-0000-00000000000c') = '--' AND pg_temp.rt('walkie:x') = '--');
RESET ROLE;

-- 02 saving and replaying
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.send_walkie(:B, current_setting('app.b64'), 'audio/mp4', 4200) AS m1 \gset
SELECT pg_temp.ok('02a send to a friend',
  (SELECT count(*) FROM public.walkie_history(:B)) = 1 AND (SELECT duration_ms FROM public.walkie_history(:B)) = 4200);
SELECT pg_temp.ok('02b not to a non-friend', pg_temp.fails(format($$SELECT public.send_walkie(%L, current_setting('app.b64'), 'audio/mp4', 1000)$$, :C)));
SELECT pg_temp.ok('02c too long / too short audio refused',
  pg_temp.fails(format($$SELECT public.send_walkie(%L, encode('x', 'base64'), 'audio/mp4', 1000)$$, :B)));
SELECT pg_temp.ok('02d no direct writes', pg_temp.fails(format($$INSERT INTO public.walkie_messages (sender_id, recipient_id, duration_ms) VALUES (%L, %L, 1000)$$, :A, :B)));
RESET ROLE; SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('02e the friend replays it (as often as they like)',
  (SELECT audio_b64 FROM public.walkie_audio(:'m1')) = current_setting('app.b64')
  AND (SELECT audio_b64 FROM public.walkie_audio(:'m1')) = current_setting('app.b64')
  AND (SELECT mime FROM public.walkie_audio(:'m1')) = 'audio/mp4');
SELECT pg_temp.ok('02f history is the same from both sides', (SELECT sender_id FROM public.walkie_history(:A)) = :A);
RESET ROLE; SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('02g outsiders see nothing',
  NOT EXISTS (SELECT 1 FROM public.walkie_audio(:'m1')) AND NOT EXISTS (SELECT 1 FROM public.walkie_messages)
  AND NOT EXISTS (SELECT 1 FROM public.walkie_history(:A)));
RESET ROLE;

-- 03 24 hours, blocks
UPDATE public.walkie_messages SET created_at = now() - interval '25 hours' WHERE id = :'m1';
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('03a older than 24 h: not listed, not playable',
  NOT EXISTS (SELECT 1 FROM public.walkie_history(:A)) AND NOT EXISTS (SELECT 1 FROM public.walkie_audio(:'m1')));
RESET ROLE;
SELECT private.expire_walkie();
SELECT pg_temp.ok('03b the hourly job deletes it, audio too',
  NOT EXISTS (SELECT 1 FROM public.walkie_messages) AND NOT EXISTS (SELECT 1 FROM private.walkie_audio));
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.send_walkie(:B, current_setting('app.b64'), 'audio/mp4', 2000);
SELECT public.block_user(:B);
SELECT pg_temp.ok('03c blocking ends the channel and wipes the history',
  pg_temp.rt(:AB) = '--' AND NOT EXISTS (SELECT 1 FROM public.walkie_history(:B))
  AND pg_temp.fails(format($$SELECT public.send_walkie(%L, current_setting('app.b64'), 'audio/mp4', 1000)$$, :B)));
RESET ROLE;
SELECT pg_temp.ok('03d nothing left in the table', NOT EXISTS (SELECT 1 FROM public.walkie_messages));
SET ROLE anon;
SELECT pg_temp.ok('03e anon: nothing', pg_temp.fails($$SELECT public.walkie_history('00000000-0000-0000-0000-00000000000a')$$)
  AND pg_temp.fails('SELECT * FROM public.walkie_messages'));
RESET ROLE;

-- 04 walkie list, open channels, unheard, notifications (Dora and Eva are friends; Chris follows Dora only)
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000d', 'dora@x', '{"full_name":"Dora"}'),
  ('00000000-0000-0000-0000-00000000000e', 'eva@x', '{"full_name":"Eva"}');
INSERT INTO public.follows (follower_id, followee_id) VALUES
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000e'),
  ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d');
\set D '''00000000-0000-0000-0000-00000000000d'''
\set E '''00000000-0000-0000-0000-00000000000e'''
SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT pg_temp.ok('04a the list has friends only, channel closed, nothing unheard',
  (SELECT count(*) FROM public.walkie_list()) = 1
  AND (SELECT user_id = :E AND NOT channel_on AND last_at IS NULL AND unheard = 0 FROM public.walkie_list()));
SELECT public.walkie_set_channel(:E, true);
SELECT pg_temp.ok('04b open a friend''s channel; not a non-friend''s',
  (SELECT channel_on FROM public.walkie_list() WHERE user_id = :E)
  AND pg_temp.fails(format('SELECT public.walkie_set_channel(%L, true)', :C)));
SELECT pg_temp.ok('04c no direct writes to walkie_contacts',
  pg_temp.fails(format('INSERT INTO public.walkie_contacts (user_id, peer_id, channel_on) VALUES (%L, %L, true)', :D, :C))
  AND pg_temp.fails(format('UPDATE public.walkie_contacts SET channel_on = true WHERE user_id = %L', :D)));
RESET ROLE; SELECT pg_temp.as_user(:E); SET ROLE authenticated;
SELECT public.send_walkie(:D, current_setting('app.b64'), 'audio/mp4', 1500);
SELECT public.send_walkie(:D, current_setting('app.b64'), 'audio/mp4', 1800);
SELECT pg_temp.ok('04d Eva doesn''t see Dora''s contacts row', NOT EXISTS (SELECT 1 FROM public.walkie_contacts));
RESET ROLE; SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT pg_temp.ok('04e two unheard, one unread walkie notice from Eva',
  (SELECT unheard = 2 AND last_at IS NOT NULL FROM public.walkie_list() WHERE user_id = :E)
  AND (SELECT count(*) FROM public.notifications WHERE kind = 'walkie' AND actor_id = :E AND read_at IS NULL) = 1);
SELECT public.walkie_seen(:E);
SELECT pg_temp.ok('04f opening Eva''s walkie: heard, notice read, channel still on',
  (SELECT unheard = 0 AND channel_on FROM public.walkie_list() WHERE user_id = :E)
  AND NOT EXISTS (SELECT 1 FROM public.notifications WHERE kind = 'walkie' AND read_at IS NULL));
RESET ROLE;
DO $$ BEGIN FOR i IN 1..10 LOOP
  INSERT INTO auth.users (id, email) VALUES (('00000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid, 'f' || i || '@x');
  INSERT INTO public.follows VALUES ('00000000-0000-0000-0000-00000000000d', ('00000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid),
    (('00000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid, '00000000-0000-0000-0000-00000000000d');
END LOOP; END $$;
SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT public.walkie_set_channel(('00000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid, true) FROM generate_series(1, 9) i;
SELECT pg_temp.ok('04g at most 10 open channels; closing one frees a place',
  pg_temp.fails($$SELECT public.walkie_set_channel('00000000-0000-0000-0001-000000000010', true)$$)
  AND pg_temp.fails(format('SELECT public.walkie_set_channel(%L, false)', :E)) = false
  AND pg_temp.fails($$SELECT public.walkie_set_channel('00000000-0000-0000-0001-000000000010', true)$$) = false);
SELECT public.block_user(:E);
SELECT pg_temp.ok('04h a blocked person leaves the list', NOT EXISTS (SELECT 1 FROM public.walkie_list() WHERE user_id = :E));
RESET ROLE; SET ROLE anon;
SELECT pg_temp.ok('04i anon: nothing', pg_temp.fails('SELECT * FROM public.walkie_list()') AND pg_temp.fails('SELECT * FROM public.walkie_contacts'));
RESET ROLE;
