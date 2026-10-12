-- Navigation quota (the Worker asks it with the caller's JWT before every routing / search call).
\set ON_ERROR_STOP 0
\set QUIET on
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'anna@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x', '{"age_confirmed":true}'),
  ('00000000-0000-0000-0000-00000000000c', 'kid@x', '{}');

CREATE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub', u, false);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false); END $$;
CREATE FUNCTION pg_temp.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '% %', CASE WHEN coalesce(cond, false) THEN 'PASS' ELSE 'FAIL' END, label; END $$;
CREATE FUNCTION pg_temp.err(stmt text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE stmt; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
-- n calls in one go; the first error (or 'ok').
CREATE FUNCTION pg_temp.calls(kind text, n int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  FOR i IN 1..n LOOP
    r := pg_temp.err(format('SELECT public.nav_quota(%L)', kind));
    IF r <> 'ok' THEN RETURN i || ':' || r; END IF;
  END LOOP;
  RETURN 'ok';
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, anon;

\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''
\set C '''00000000-0000-0000-0000-00000000000c'''

SET ROLE anon;
SELECT pg_temp.ok('01 not signed in: no quota (anon can''t even call it)', pg_temp.err($$SELECT public.nav_quota('route')$$) LIKE 'permission denied%');
RESET ROLE;

SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('02 a route: allowed', pg_temp.err($$SELECT public.nav_quota('route')$$) = 'ok');
SELECT pg_temp.ok('03 anything else than route / search: bad_input', pg_temp.err($$SELECT public.nav_quota('geocode')$$) = 'bad_input');
SELECT set_config('app.r', pg_temp.calls('route', 60), false);
SELECT pg_temp.ok('04 routes: 60 per 10 minutes, the 60th call over the limit is refused (' || current_setting('app.r') || ')',
  current_setting('app.r') = '60:rate_limited');
SELECT set_config('app.r', pg_temp.calls('search', 151), false);
SELECT pg_temp.ok('05 search has its own limit: 150 per 10 minutes (' || current_setting('app.r') || ')', current_setting('app.r') = '151:rate_limited');
RESET ROLE;

-- An old window: the 10-minute limit frees up, the daily one still counts.
UPDATE private.rate_events SET at = now() - interval '11 minutes' WHERE user_id = :A;
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('06 after 10 minutes routes work again', pg_temp.err($$SELECT public.nav_quota('route')$$) = 'ok');
RESET ROLE;
INSERT INTO private.rate_events (user_id, action, at) SELECT :A, 'nav_route_day', now() - interval '2 hours' FROM generate_series(1, 500);
SELECT pg_temp.as_user(:A); SET ROLE authenticated;
SELECT pg_temp.ok('07 … but at most 500 a day', pg_temp.err($$SELECT public.nav_quota('route')$$) = 'rate_limited');
RESET ROLE;

SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('08 limits are per person (Bob is not limited by Anna)', pg_temp.err($$SELECT public.nav_quota('route')$$) = 'ok');
RESET ROLE;

SELECT pg_temp.as_user(:C); SET ROLE authenticated;
SELECT pg_temp.ok('09 no 18+ declaration: age_not_confirmed', pg_temp.err($$SELECT public.nav_quota('route')$$) = 'age_not_confirmed');
RESET ROLE;
UPDATE public.profiles SET disabled = true WHERE id = :B;
SELECT pg_temp.as_user(:B); SET ROLE authenticated;
SELECT pg_temp.ok('10 a disabled account: not_allowed', pg_temp.err($$SELECT public.nav_quota('search')$$) = 'not_allowed');
RESET ROLE;
SELECT pg_temp.ok('11 SECURITY DEFINER with an empty search_path',
  (SELECT prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE proname = 'nav_quota'));
