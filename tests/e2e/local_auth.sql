-- LOCAL TEST DATABASE ONLY (never a migration): email + password accounts for the mini Supabase Auth in
-- local-supabase.mjs. Passwords are stored as sha256 hex — fine for throwaway test data, nothing else.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS local_password text;

CREATE OR REPLACE FUNCTION public.local_signup(p_email text, p_password text, p_meta jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = lower(p_email)) THEN
    RAISE EXCEPTION 'user_already_exists';
  END IF;
  INSERT INTO auth.users (email, raw_user_meta_data, local_password)
  VALUES (lower(p_email), coalesce(p_meta, '{}'), encode(sha256(convert_to(p_password, 'UTF8')), 'hex'))
  RETURNING id INTO uid;
  RETURN uid;
END $$;

CREATE OR REPLACE FUNCTION public.local_login(p_email text, p_password text)
RETURNS TABLE (id uuid, email text, meta jsonb) LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.id, u.email, u.raw_user_meta_data FROM auth.users u
  WHERE lower(u.email) = lower(p_email) AND u.local_password = encode(sha256(convert_to(p_password, 'UTF8')), 'hex')
$$;
GRANT EXECUTE ON FUNCTION public.local_signup(text, text, jsonb), public.local_login(text, text) TO anon, authenticated;
