-- Walkie diagnostics (2026-10-03): live audio reaches the server and the other phone's Realtime client (checked with
-- a probe), but users still hear nothing live on iPhone. Each transmission / reception now reports technical counters
-- only (pieces sent / received / played, audio context state, sample rate, levels, device) — never audio. Read with
-- the service role; kept 3 days. Since 2026-10-03 (walkie confirmed live) the app reports only anomalies (nothing sent,
-- pieces lost, failed sends, replays of missed transmissions) — the alarm if it ever breaks again.
CREATE TABLE private.walkie_diag (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);
CREATE INDEX walkie_diag_at ON private.walkie_diag (at);

CREATE FUNCTION public.walkie_diag(p_data jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := private.me();
BEGIN
  IF length(p_data::text) > 4000 THEN RETURN; END IF;
  IF (SELECT count(*) FROM private.walkie_diag WHERE user_id = uid AND at > now() - interval '1 hour') >= 200 THEN RETURN; END IF;
  INSERT INTO private.walkie_diag (user_id, data) VALUES (uid, p_data);
END $$;
REVOKE EXECUTE ON FUNCTION public.walkie_diag(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.walkie_diag(jsonb) TO authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('expire-walkie-diag', '41 3 * * *', $$DELETE FROM private.walkie_diag WHERE at < now() - interval '3 days'$$);
  END IF;
END
$cron$;
