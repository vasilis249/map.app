-- Minimal stand-ins for the Supabase-managed schemas so migrations can be validated on plain Postgres.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE supabase_admin NOLOGIN;
CREATE ROLE supabase_realtime_admin NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA extensions;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')::text $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, owner uuid, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now()
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
$$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
CREATE PUBLICATION supabase_realtime;
CREATE SCHEMA realtime;
CREATE TABLE realtime.messages (id bigserial PRIMARY KEY, topic text, extension text, payload jsonb, event text, private boolean, inserted_at timestamptz DEFAULT now());
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic', true) $$;
-- Realtime authorization like the hosted project: RLS on realtime.messages (a new project has no policies on it,
-- so private channels are refused unless a migration allows them).
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA realtime TO authenticated, anon;
GRANT SELECT, INSERT ON realtime.messages TO authenticated;
GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO authenticated;
GRANT EXECUTE ON FUNCTION realtime.topic() TO authenticated, anon;
-- For the local Realtime mock (tests/e2e/realtime-mock.mjs): may the caller read / write this private topic?
-- Evaluates the RLS policies the way the Realtime server does (probe row, then SELECT / INSERT as the user).
CREATE FUNCTION realtime.probe(p_topic text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS
$$ INSERT INTO realtime.messages (topic, extension, private) VALUES (p_topic, 'broadcast', true) RETURNING id $$;
GRANT EXECUTE ON FUNCTION realtime.probe(text) TO authenticated;
-- Broadcast from the database (hosted: realtime.send writes a message the server relays to the topic).
CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true) RETURNS void
LANGUAGE sql AS $$ INSERT INTO realtime.messages (topic, extension, payload, event, private) VALUES ($3, 'broadcast', $1, $2, $4) $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
GRANT anon, authenticated, service_role TO postgres;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'authpw';
  END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;
-- Supabase lets signed-in users reach storage rows (RLS decides what they see).
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT SELECT ON storage.buckets TO authenticated;
