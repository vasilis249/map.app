-- Map like Find My: friends keep their last known position on your map for up to 1 hour (shown with its age, e.g.
-- "πριν 20λ"), so a friend whose phone stands still (iOS sends nothing while you don't move) doesn't vanish after
-- 15 minutes. People who aren't friends still need a position less than 15 minutes old, from both of you.
-- Nothing is kept longer than before: positions are still deleted after 1 hour (expire-locations).

CREATE OR REPLACE FUNCTION public.map_people(p_radius_m int DEFAULT 500)
RETURNS TABLE (user_id uuid, username text, full_name text, avatar_path text, lat double precision,
               lng double precision, accuracy_m real, heading real, updated_at timestamptz, distance_m int,
               is_friend boolean, can_talk boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := private.me();
  me_loc private.user_locations;
  me_fresh boolean;
  r int := least(greatest(coalesce(p_radius_m, 500), 50), 500);
  dlat double precision;
  dlng double precision;
BEGIN
  IF coalesce((SELECT ls.mode FROM public.location_sharing ls WHERE ls.user_id = uid), 'off') = 'off' THEN RETURN; END IF;
  -- Reciprocity: you share too, with a position of the last hour (friends) / 15 minutes (everyone else).
  SELECT * INTO me_loc FROM private.user_locations ul WHERE ul.user_id = uid AND ul.updated_at > now() - interval '1 hour';
  IF NOT FOUND THEN RETURN; END IF;
  me_fresh := me_loc.updated_at > now() - interval '15 minutes';
  dlat := r / 111320.0;
  dlng := r / (111320.0 * greatest(cos(radians(me_loc.lat)), 0.01));
  RETURN QUERY
  WITH cand AS (
    SELECT l.*, s.mode, s.talk_from, private.are_friends(uid, l.user_id) AS friend,
           private.distance_m(me_loc.lat, me_loc.lng, l.lat, l.lng) AS dist
    FROM private.user_locations l
    JOIN public.location_sharing s ON s.user_id = l.user_id AND s.mode <> 'off'
    JOIN public.profiles p ON p.id = l.user_id AND NOT p.disabled
    WHERE l.user_id <> uid AND l.updated_at > now() - interval '1 hour'
      AND NOT private.is_blocked(uid, l.user_id)
  )
  SELECT c.user_id, p.username, p.full_name, p.avatar_path, c.lat, c.lng, c.accuracy_m, c.heading, c.updated_at,
         round(c.dist)::int,
         c.friend,
         (c.dist <= 500 AND c.updated_at > now() - interval '15 minutes' AND me_fresh
          AND (c.talk_from = 'everyone' OR (c.talk_from = 'following' AND private.follows(c.user_id, uid))))
           OR private.knocked_recently(c.user_id, uid)
  FROM cand c JOIN public.profiles p ON p.id = c.user_id
  WHERE (c.friend AND c.mode IN ('friends', 'everyone'))
     OR (c.mode = 'everyone' AND me_fresh AND c.updated_at > now() - interval '15 minutes'
         AND c.lat BETWEEN me_loc.lat - dlat AND me_loc.lat + dlat
         AND c.lng BETWEEN me_loc.lng - dlng AND me_loc.lng + dlng
         AND c.dist <= r)
  ORDER BY 10
  LIMIT 200;
END $$;

REVOKE EXECUTE ON FUNCTION public.map_people(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.map_people(int) TO authenticated;
