-- P7: Waze's full report catalog. The baseline is live (D11): changes come as new migrations.
--   kinds: + camera (speed / red-light camera, lives 30 days, kept alive by confirmations) and help (roadside help);
--   sub:   an optional detail per kind (heavy traffic, hidden police, pothole, fog, …), validated by the server;
--          'other_side' (police / accident) is on the opposite carriageway: the app applies it to the other direction,
--          and it is never merged with a report on your side;
--   ttl:   by kind and detail (road works 1 day, weather 3 h, a major accident 2 h, …);
--   road_withdraw: take your own report back (the problem is gone, or help arrived) — no strike.
-- Anonymity, blocks, votes, strikes, privacy deletion and moderation stay as in the baseline (11d).

CREATE FUNCTION private.road_sub_ok(p_kind text, p_sub text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_sub IS NULL OR p_sub = ANY (CASE p_kind
    WHEN 'traffic' THEN ARRAY['moderate', 'heavy', 'standstill']
    WHEN 'police' THEN ARRAY['visible', 'hidden', 'other_side']
    WHEN 'accident' THEN ARRAY['minor', 'major', 'other_side']
    WHEN 'hazard' THEN ARRAY['object', 'pothole', 'roadwork', 'light_out', 'stopped_car', 'animal', 'shoulder',
                             'fog', 'flood', 'ice', 'hail']
    WHEN 'camera' THEN ARRAY['speed', 'red_light']
    WHEN 'help' THEN ARRAY['tire', 'battery', 'fuel', 'other']
    ELSE ARRAY[]::text[]
  END)
$$;

ALTER TABLE private.road_reports DROP CONSTRAINT road_reports_kind_check;
ALTER TABLE private.road_reports ADD CONSTRAINT road_reports_kind_check
  CHECK (kind IN ('accident', 'police', 'hazard', 'traffic', 'closed', 'camera', 'help'));
ALTER TABLE private.road_reports ADD COLUMN sub text;
ALTER TABLE private.road_reports ADD CONSTRAINT road_reports_sub_check CHECK (private.road_sub_ok(kind, sub));

-- How long a report lives (and what a "still there" can extend it to: half of this from now).
CREATE FUNCTION private.road_ttl(p_kind text, p_sub text)
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_kind = 'hazard' AND p_sub = 'roadwork' THEN interval '1 day'
    WHEN p_kind = 'hazard' AND p_sub IN ('fog', 'flood', 'ice', 'hail') THEN interval '3 hours'
    WHEN p_kind = 'accident' AND p_sub = 'major' THEN interval '2 hours'
    WHEN p_kind = 'traffic' THEN interval '30 minutes'
    WHEN p_kind IN ('police', 'accident', 'help') THEN interval '1 hour'
    WHEN p_kind = 'hazard' THEN interval '2 hours'
    WHEN p_kind = 'closed' THEN interval '6 hours'
    WHEN p_kind = 'camera' THEN interval '30 days'
  END
$$;

DROP FUNCTION public.road_report(text, double precision, double precision, real);

-- Report something at (p_lat, p_lng) in your direction of travel (p_heading), with an optional detail (p_sub).
-- Returns the report's id (an existing one nearby of the same kind and side when this is a confirmation; a confirmation
-- with a detail fills in one that had none). Errors: bad_input, too_many_strikes, rate_limited.
CREATE FUNCTION public.road_report(p_kind text, p_lat double precision, p_lng double precision,
                                   p_heading real DEFAULT NULL, p_sub text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  ttl interval := private.road_ttl(p_kind, p_sub);
  -- a camera is a point: two of them 60 m apart are two cameras
  within_m double precision := CASE WHEN p_kind = 'camera' THEN 40 ELSE 100 END;
  same private.road_reports;
  rid uuid;
BEGIN
  IF ttl IS NULL OR NOT private.road_sub_ok(p_kind, p_sub) OR p_lat IS NULL OR p_lng IS NULL
     OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023';
  END IF;
  -- Five reports voted away / removed in a week: no more reports for now.
  IF (SELECT count(*) FROM private.road_strikes WHERE user_id = uid AND at > now() - interval '7 days') >= 5 THEN
    RAISE EXCEPTION 'too_many_strikes' USING ERRCODE = '42501';
  END IF;
  PERFORM private.rate_limit('road_report', 10, interval '10 minutes');
  PERFORM private.rate_limit('road_report_day', 40, interval '1 day');
  SELECT * INTO same FROM private.road_reports r
  WHERE r.kind = p_kind AND private.road_active(r)
    AND (r.sub IS NOT DISTINCT FROM 'other_side') = (p_sub IS NOT DISTINCT FROM 'other_side')
    AND r.lat BETWEEN p_lat - 0.001 AND p_lat + 0.001
    AND r.lng BETWEEN p_lng - 0.0015 AND p_lng + 0.0015
    AND private.distance_m(r.lat, r.lng, p_lat, p_lng) <= within_m
    AND NOT private.is_blocked(uid, r.created_by)
  ORDER BY private.distance_m(r.lat, r.lng, p_lat, p_lng) LIMIT 1;
  IF FOUND THEN
    IF same.sub IS NULL AND p_sub IS NOT NULL THEN
      UPDATE private.road_reports SET sub = p_sub WHERE id = same.id;
    END IF;
    IF same.created_by <> uid THEN PERFORM public.road_vote(same.id, 1); END IF;
    RETURN same.id;
  END IF;
  INSERT INTO private.road_reports (kind, sub, lat, lng, heading, created_by, expires_at)
  VALUES (p_kind, p_sub, p_lat, p_lng, CASE WHEN p_heading >= 0 AND p_heading < 360 THEN p_heading END, uid, now() + ttl)
  RETURNING id INTO rid;
  RETURN rid;
END $$;

-- "Still there" (+1) / "not there" (-1); as in the baseline, with the detail's lifetime.
CREATE OR REPLACE FUNCTION public.road_vote(p_id uuid, p_vote int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  r private.road_reports;
BEGIN
  IF p_vote NOT IN (-1, 1) THEN RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM private.road_reports x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT private.road_active(r) OR private.is_blocked(uid, r.created_by) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF r.created_by = uid THEN RAISE EXCEPTION 'own_report' USING ERRCODE = '42501'; END IF;
  PERFORM private.rate_limit('road_vote', 60, interval '10 minutes');
  INSERT INTO private.road_votes AS v (report_id, user_id, vote) VALUES (p_id, uid, p_vote)
  ON CONFLICT (report_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, at = now();
  UPDATE private.road_reports x SET
    up = (SELECT count(*) FROM private.road_votes v WHERE v.report_id = p_id AND v.vote = 1),
    down = (SELECT count(*) FROM private.road_votes v WHERE v.report_id = p_id AND v.vote = -1),
    expires_at = CASE WHEN p_vote = 1 THEN greatest(x.expires_at, now() + private.road_ttl(x.kind, x.sub) / 2)
                      ELSE x.expires_at END
  WHERE x.id = p_id;
  IF (SELECT down - up FROM private.road_reports WHERE id = p_id) >= 2 THEN
    PERFORM private.road_remove(p_id, NULL);
  END IF;
END $$;

DROP FUNCTION private.road_ttl(text);

-- Take your own report back (gone, or help arrived): hidden at once, no strike. Errors: not_found.
CREATE FUNCTION public.road_withdraw(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  UPDATE private.road_reports SET removed_at = now(), removed_by = uid
  WHERE id = p_id AND created_by = uid AND removed_at IS NULL AND expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
END $$;

DROP FUNCTION public.road_reports_in(double precision, double precision, double precision, double precision);

-- Active reports in a box, as in the baseline, with the detail. Who made them is never returned.
CREATE FUNCTION public.road_reports_in(p_min_lat double precision, p_min_lng double precision,
                                       p_max_lat double precision, p_max_lng double precision)
RETURNS TABLE (id uuid, kind text, sub text, lat double precision, lng double precision, heading real,
               created_at timestamptz, expires_at timestamptz, up int, down int, mine boolean, voted int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF p_min_lat IS NULL OR p_max_lat IS NULL OR p_min_lng IS NULL OR p_max_lng IS NULL
     OR p_max_lat < p_min_lat OR p_max_lng < p_min_lng OR p_max_lat - p_min_lat > 2 OR p_max_lng - p_min_lng > 2.5 THEN
    RAISE EXCEPTION 'bad_input' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT r.id, r.kind, r.sub, r.lat, r.lng, r.heading, r.created_at, r.expires_at, r.up, r.down, r.created_by = uid,
         coalesce((SELECT v.vote::int FROM private.road_votes v WHERE v.report_id = r.id AND v.user_id = uid), 0)
  FROM private.road_reports r
  JOIN public.profiles p ON p.id = r.created_by AND NOT p.disabled
  WHERE r.removed_at IS NULL AND r.expires_at > now()
    AND r.lat BETWEEN p_min_lat AND p_max_lat AND r.lng BETWEEN p_min_lng AND p_max_lng
    AND NOT private.is_blocked(uid, r.created_by)
  ORDER BY abs(r.lat - (p_min_lat + p_max_lat) / 2) + abs(r.lng - (p_min_lng + p_max_lng) / 2)
  LIMIT 300;
END $$;

-- Privileges (as the baseline's section 12: new functions are for signed-in users only, private helpers for nobody).
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_blocked(uuid, uuid), private.walkie_topic_ok(text), private.nearby_topic_ok(text)
  TO authenticated;
