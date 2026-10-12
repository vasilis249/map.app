-- Local Realtime mock (realtime-mock.mjs): may the caller (JWT via PostgREST) read / write this private topic?
CREATE OR REPLACE FUNCTION public.rt_authorize(p_topic text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE pid bigint; r boolean; w boolean := true;
BEGIN
  PERFORM set_config('realtime.topic', p_topic, true);
  pid := realtime.probe(p_topic);
  SELECT EXISTS (SELECT 1 FROM realtime.messages WHERE id = pid) INTO r;
  BEGIN
    INSERT INTO realtime.messages (topic, extension, private) VALUES (p_topic, 'broadcast', true);
  EXCEPTION WHEN OTHERS THEN w := false; END;
  RETURN jsonb_build_object('read', r, 'write', w);
END $$;
GRANT EXECUTE ON FUNCTION public.rt_authorize(text) TO authenticated;
-- Broadcasts written by the database (realtime.send) for the mock to relay: rows with an event, after an id. p_db is
-- the database the caller polled last (its oid): a reset recreates the database, so a different one means "start
-- from the beginning" (its ids start again). The first call (p_db null) only learns where things stand.
DROP FUNCTION IF EXISTS public.rt_poll(bigint);
CREATE OR REPLACE FUNCTION public.rt_poll(p_after bigint, p_db bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  db bigint := (SELECT oid::bigint FROM pg_database WHERE datname = current_database());
  a bigint := CASE WHEN p_db IS DISTINCT FROM db THEN 0 ELSE coalesce(p_after, 0) END;
  rows jsonb;
BEGIN
  IF p_db IS NULL THEN
    RETURN jsonb_build_object('db', db, 'after', (SELECT coalesce(max(m.id), 0) FROM realtime.messages m), 'rows', '[]'::jsonb);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'topic', x.topic, 'event', x.event, 'payload', x.payload) ORDER BY x.id), '[]')
  INTO rows
  FROM (SELECT m.id, m.topic, m.event, m.payload FROM realtime.messages m
        WHERE m.event IS NOT NULL AND m.id > a ORDER BY m.id LIMIT 100) x;
  RETURN jsonb_build_object('db', db,
    'after', greatest(a, coalesce((SELECT max((r ->> 'id')::bigint) FROM jsonb_array_elements(rows) r), a)), 'rows', rows);
END $$;
GRANT EXECUTE ON FUNCTION public.rt_poll(bigint, bigint) TO anon, authenticated;
