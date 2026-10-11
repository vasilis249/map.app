-- Live map, part 2: your own position comes back with your settings (the map centres on it).
DROP FUNCTION public.my_location_sharing();
CREATE FUNCTION public.my_location_sharing()
RETURNS TABLE (mode text, talk_from text, has_position boolean, position_at timestamptz, lat double precision,
               lng double precision, accuracy_m real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(s.mode, 'off'), coalesce(s.talk_from, 'everyone'), l.user_id IS NOT NULL, l.updated_at, l.lat, l.lng,
         l.accuracy_m
  FROM (SELECT private.me() AS uid) me
  LEFT JOIN public.location_sharing s ON s.user_id = me.uid
  LEFT JOIN private.user_locations l ON l.user_id = me.uid
$$;
REVOKE EXECUTE ON FUNCTION public.my_location_sharing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_location_sharing() TO authenticated;
