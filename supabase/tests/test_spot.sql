-- P8 spot exchange: vehicle + plate, offer, claim (credits, one winner), what each side sees (plate only to the mate,
-- only while active), live positions, quick messages, arrival, done → credits / points, cancel / no-show, blocks,
-- push-to-talk between mates, expiry, leaderboard, access.
\set ON_ERROR_STOP 0
\set QUIET on
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'anna@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000c', 'chris@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000d', 'dora@x', '{"age_confirmed":true}');

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
\set BOX '37.96, 23.72, 37.99, 23.75'

-- 01 vehicle
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('01a no exchange without a vehicle', pg_temp.err($$SELECT public.spot_offer(37.97, 23.73, 2)$$) = 'no_vehicle');
SELECT public.set_my_vehicle('ΙΚΑ-1234', ' Toyota  Yaris ', 'white');
SELECT pg_temp.ok('01b plate normalized (Greek letters → the Latin ones they look like, no dash), make tidied',
  (SELECT plate = 'IKA1234' AND make = 'Toyota Yaris' AND colour = 'white' FROM public.my_vehicle()));
SELECT pg_temp.ok('01c bad plates / colours refused',
  pg_temp.err($$SELECT public.set_my_vehicle('12', NULL, 'white')$$) = 'bad_plate'
  AND pg_temp.err($$SELECT public.set_my_vehicle('ΑΒΓΔΕ', NULL, 'white')$$) = 'bad_plate'
  AND pg_temp.err($$SELECT public.set_my_vehicle('IKA1234; DROP', NULL, 'white')$$) = 'bad_plate'
  AND pg_temp.err($$SELECT public.set_my_vehicle('IKA1234', NULL, 'pink')$$) = 'bad_input');
SELECT pg_temp.ok('01d the vehicles table is not readable directly', pg_temp.err('SELECT * FROM private.vehicles') LIKE 'permission denied%');
RESET ROLE;
SELECT pg_temp.as_user(:B); SET ROLE authenticated; SELECT public.set_my_vehicle('ZKP 4521', 'Fiat Panda', 'red'); RESET ROLE;
SELECT pg_temp.as_user(:C); SET ROLE authenticated; SELECT public.set_my_vehicle('XAA9876', NULL, 'blue'); RESET ROLE;

-- 02 offer
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.o1', public.spot_offer(37.9700, 23.7300, 2)::text, false);
SELECT pg_temp.ok('02a Anna offers her spot, leaving in 2 minutes; a second one at the same time refused',
  (SELECT (spot_state() -> 'offer' ->> 'state') = 'open')
  AND pg_temp.err($$SELECT public.spot_offer(37.97, 23.73, 0)$$) = 'already_active'
  AND pg_temp.err($$SELECT public.spot_offer(37.97, 23.73, 7)$$) = 'bad_input');
SELECT pg_temp.ok('02b she doesn''t see her own offer in the list', NOT EXISTS (SELECT 1 FROM public.spot_offers_in(:BOX)));
RESET ROLE;
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('02c Bob sees it: place and time only (who is unknown before a match)',
  (SELECT count(*) = 1 FROM public.spot_offers_in(:BOX) WHERE id = current_setting('app.o1')::uuid)
  AND (SELECT NOT ('user_id' = ANY (proargnames)) FROM pg_proc WHERE proname = 'spot_offers_in'));
SELECT pg_temp.ok('02d a new user starts with 1 credit, 100% reliability',
  (SELECT (spot_state() -> 'wallet' ->> 'credits')::int = 1 AND (spot_state() -> 'wallet' ->> 'reliability')::int = 100));

-- 03 claim: too far / first wins / credits
SELECT pg_temp.ok('03a claiming from 10 km away refused', pg_temp.err(format('SELECT public.spot_claim(%L, 38.06, 23.73)', current_setting('app.o1'))) = 'too_far');
SELECT set_config('app.m1', public.spot_claim(current_setting('app.o1')::uuid, 37.9800, 23.7400)::text, false);
SELECT pg_temp.ok('03b Bob claims it: matched, one credit spent',
  (SELECT (spot_state() -> 'match' ->> 'role') = 'taker' AND (spot_state() -> 'wallet' ->> 'credits')::int = 0));
RESET ROLE;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('03c Chris, a moment later: taken (and it is gone from the list)',
  pg_temp.err(format('SELECT public.spot_claim(%L, 37.975, 23.735)', current_setting('app.o1'))) = 'taken'
  AND NOT EXISTS (SELECT 1 FROM public.spot_offers_in(:BOX)));
RESET ROLE;

-- 04 what each side sees
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('04a Anna (giver) sees her mate Bob: name and his car — plate, make, colour',
  (SELECT s -> 'match' ->> 'role' = 'giver' AND s -> 'match' -> 'mate' ->> 'username' IS NOT NULL
     AND s -> 'match' -> 'mate' ->> 'plate' = 'ZKP4521' AND s -> 'match' -> 'mate' ->> 'colour' = 'red'
   FROM (SELECT public.spot_state() s) x));
SELECT public.spot_update(37.9701, 23.7301);
SELECT public.spot_message('waiting');
RESET ROLE;
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.spot_update(37.9750, 23.7350, 240);
SELECT pg_temp.ok('04b Bob (taker) sees Anna''s car, her live position and her message',
  (SELECT s -> 'match' -> 'mate' ->> 'plate' = 'IKA1234' AND (s -> 'match' -> 'mate_pos' ->> 'lat')::float = 37.9701
     AND s -> 'match' ->> 'mate_msg' = 'waiting' FROM (SELECT public.spot_state() s) x));
SELECT pg_temp.ok('04c only quick messages from the list', pg_temp.err($$SELECT public.spot_message('call me 69...')$$) = 'bad_input');
RESET ROLE;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('04d Chris (not in it) gets no match and nobody''s plate', (SELECT NOT (public.spot_state() ? 'match')));
RESET ROLE;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('04e Anna sees Bob''s ETA (4 min)', (SELECT (public.spot_state() -> 'match' ->> 'eta_s')::int = 240));
RESET ROLE;

-- 05 push-to-talk between the mates, at any distance, while it runs
SELECT pg_temp.ok('05a spot mates may talk (nearby voice), others may not',
  private.may_send_nearby(:A, :B) AND private.may_send_nearby(:B, :A) AND NOT private.may_send_nearby(:A, :C));

-- 06 arrival + done
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_sleep(1);
SELECT public.spot_update(37.97015, 23.73005, 0);
SELECT pg_temp.ok('06a Bob within 60 m of the spot: arrived', (SELECT public.spot_state() -> 'match' ->> 'arrived_at' IS NOT NULL));
RESET ROLE;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('06b only the taker says "parked"', pg_temp.err('SELECT public.spot_done()') = 'not_taker');
RESET ROLE;
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.spot_done();
SELECT pg_temp.ok('06c done: Bob +5 points, one exchange; the car / position no longer shown',
  (SELECT s -> 'match' ->> 'state' = 'done' AND s -> 'match' -> 'mate' ->> 'plate' IS NULL AND NOT (s -> 'match' ? 'mate_pos' AND s -> 'match' -> 'mate_pos' <> 'null')
     AND (s -> 'wallet' ->> 'points')::int = 5 AND (s -> 'wallet' ->> 'exchanges')::int = 1
   FROM (SELECT public.spot_state() s) x));
RESET ROLE;
SELECT pg_temp.ok('06d Anna: +1 credit (2 now), +10 points; positions wiped from the row; talk channel closed',
  (SELECT credits = 2 AND points = 10 AND exchanges = 1 FROM private.spot_wallets WHERE user_id = :A)
  AND (SELECT giver_lat IS NULL AND taker_lat IS NULL FROM private.spot_matches WHERE id = current_setting('app.m1')::uuid)
  AND NOT private.spot_mates(:A, :B));

-- 07 cancel by the giver: credit back to the taker, giver's reliability down
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.o2', public.spot_offer(37.9700, 23.7300, 0)::text, false);
RESET ROLE;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.spot_claim(current_setting('app.o2')::uuid, 37.975, 23.735);
RESET ROLE;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.spot_cancel();
SELECT pg_temp.ok('07a the giver cancels: Chris gets his credit back, Anna 1 cancellation (reliability 50%)',
  (SELECT (public.spot_state() -> 'wallet' ->> 'reliability')::int = 50));
RESET ROLE;
SELECT pg_temp.ok('07b … Chris has 1 credit again', (SELECT credits = 1 FROM private.spot_wallets WHERE user_id = :C));

-- 08 no-show by the giver (taker arrived, she wasn't there)
SELECT pg_temp.as_user(:D); SET ROLE authenticated; SELECT public.set_my_vehicle('NIK2024', NULL, 'black');
SELECT set_config('app.o3', public.spot_offer(37.9800, 23.7450, 0)::text, false);
RESET ROLE;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.spot_claim(current_setting('app.o3')::uuid, 37.975, 23.735);
SELECT pg_temp.ok('08a "not there" before arriving: too early', pg_temp.err('SELECT public.spot_cancel(true)') = 'too_early');
SELECT public.spot_update(37.98005, 23.7450, 0);
SELECT public.spot_cancel(true);
SELECT pg_temp.ok('08b after arriving: "she wasn''t there" → Chris''s credit back', (SELECT (public.spot_state() -> 'wallet' ->> 'credits')::int = 1));
RESET ROLE;
SELECT pg_temp.ok('08c … Dora: a no-show, a strike, no points below 0',
  (SELECT no_shows = 1 AND points = 0 FROM private.spot_wallets WHERE user_id = :D)
  AND (SELECT count(*) = 1 FROM private.spot_strikes WHERE user_id = :D));
INSERT INTO private.spot_strikes (user_id) VALUES (:D), (:D);
SELECT pg_temp.as_user(:D); SET ROLE authenticated;
SELECT pg_temp.ok('08d 3 no-shows in a week: no exchanges for a day', pg_temp.err($$SELECT public.spot_offer(37.98, 23.745, 0)$$) = 'spot_blocked');
RESET ROLE;
DELETE FROM private.spot_strikes WHERE user_id = :D;

-- 09 taker cancels late (no credit back; the offer opens again); a block ends an exchange
UPDATE private.spot_wallets SET credits = 1 WHERE user_id = :B;  -- (Bob spent his in 03)
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.o4', public.spot_offer(37.9700, 23.7300, 5)::text, false);
RESET ROLE;
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.spot_claim(current_setting('app.o4')::uuid, 37.975, 23.735);
RESET ROLE;
UPDATE private.spot_matches SET created_at = now() - interval '3 minutes' WHERE state = 'active' AND taker = :B;
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT public.spot_cancel();
RESET ROLE;
SELECT pg_temp.ok('09a the taker cancels after 2 min: no credit back, a cancellation, the offer is open again',
  (SELECT credits = 0 AND cancels = 1 FROM private.spot_wallets WHERE user_id = :B)
  AND (SELECT state = 'open' FROM private.spot_offers WHERE id = current_setting('app.o4')::uuid));
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT public.spot_claim(current_setting('app.o4')::uuid, 37.975, 23.735);
RESET ROLE;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT public.block_user(:C);
RESET ROLE;
SELECT pg_temp.ok('09b Anna blocks Chris during the exchange: it ends, his credit back',
  NOT private.spot_mates(:A, :C) AND (SELECT credits = 1 FROM private.spot_wallets WHERE user_id = :C));
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT set_config('app.o5', public.spot_offer(37.9700, 23.7300, 0)::text, false);
RESET ROLE;
SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('09c … and he can''t see or claim her offers any more',
  NOT EXISTS (SELECT 1 FROM public.spot_offers_in(:BOX) WHERE id = current_setting('app.o5')::uuid)
  AND pg_temp.err(format('SELECT public.spot_claim(%L, 37.975, 23.735)', current_setting('app.o5'))) = 'taken');
RESET ROLE;

-- 10 no credits; expiry; leaderboard
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('10a no credits left: give a spot first', pg_temp.err(format('SELECT public.spot_claim(%L, 37.975, 23.735)', current_setting('app.o5'))) = 'no_credits');
SELECT pg_temp.ok('10b the weekly leaderboard: Anna first (10), Bob after (5)',
  (SELECT array_agg(points ORDER BY rank) = ARRAY[10, 5] FROM public.spot_leaderboard()));
RESET ROLE;
UPDATE private.spot_offers SET leave_at = now() - interval '11 minutes' WHERE id = current_setting('app.o5')::uuid;
SELECT private.expire_spots();
SELECT pg_temp.ok('10c an offer 10 min past its time expires', (SELECT state = 'expired' FROM private.spot_offers WHERE id = current_setting('app.o5')::uuid));

-- 11 access
SET ROLE anon;
SELECT pg_temp.ok('11a anon can''t offer, list, claim or read state',
  pg_temp.err($$SELECT public.spot_offer(37.9, 23.7, 0)$$) LIKE 'permission denied%'
  AND pg_temp.err($$SELECT * FROM public.spot_offers_in(37.96, 23.72, 37.99, 23.75)$$) LIKE 'permission denied%'
  AND pg_temp.err($$SELECT public.spot_state()$$) LIKE 'permission denied%'
  AND pg_temp.err($$SELECT public.my_vehicle()$$) LIKE 'permission denied%');
RESET ROLE;
SELECT pg_temp.ok('11b helpers not callable by users',
  NOT has_function_privilege('authenticated', 'private.spot_mates(uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'private.expire_spots()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'private.normalize_plate(text)', 'EXECUTE'));
DELETE FROM auth.users WHERE id = :A;
SELECT pg_temp.ok('11c deleting an account deletes its vehicle, wallet, offers and exchanges',
  NOT EXISTS (SELECT 1 FROM private.vehicles WHERE user_id = :A) AND NOT EXISTS (SELECT 1 FROM private.spot_wallets WHERE user_id = :A)
  AND NOT EXISTS (SELECT 1 FROM private.spot_offers WHERE user_id = :A) AND NOT EXISTS (SELECT 1 FROM private.spot_matches WHERE giver = :A));
