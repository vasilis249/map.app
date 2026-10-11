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
-- Broadcasts written by the database (realtime.send) for the mock to relay: rows with an event, after an id
-- (a reset database starts its ids again: then everything it has).
CREATE OR REPLACE FUNCTION public.rt_poll(p_after bigint) RETURNS TABLE (id bigint, topic text, event text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE a bigint := p_after;
BEGIN
  IF a > (SELECT coalesce(max(m.id), 0) FROM realtime.messages m) THEN a := 0; END IF;
  RETURN QUERY SELECT m.id, m.topic, m.event, m.payload FROM realtime.messages m
  WHERE m.event IS NOT NULL AND m.id > a ORDER BY m.id LIMIT 100;
END $$;
GRANT EXECUTE ON FUNCTION public.rt_poll(bigint) TO anon, authenticated;
