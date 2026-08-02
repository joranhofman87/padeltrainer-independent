-- ===========================================================================
-- platform_stub.sql — inert stand-ins for the two capabilities a rehearsal
-- target must not have, installed BEFORE the sanitized migration chain runs.
--
-- The chain installs pg_cron and pg_net (20260117134212, 20260330204208).
-- synth/sanitize-migrations.mjs neutralises those CREATE EXTENSION statements,
-- so the extensions never exist here; this file supplies the objects the rest of
-- the chain still references. Scheduling is RECORDED, never scheduled; outbound
-- calls are COUNTED, never made.
--
-- An earlier revision created these objects and left the CREATE EXTENSION
-- statements in place. That could not work — the extension creates the same
-- schema and table and collides, and once it succeeds the target has a real
-- scheduler again. Sanitising the source is what makes the stand-ins safe.
--
-- FAIL CLOSED: if the real extensions are already installed we cannot shadow
-- them, so this refuses and the operator must use a project without them.
-- ===========================================================================
\ir _assert.sql

DO $$
DECLARE e text;
BEGIN
  FOREACH e IN ARRAY ARRAY['pg_cron', 'pg_net'] LOOP
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = e) THEN
      RAISE EXCEPTION '% is INSTALLED on this target, so the inert stand-in cannot be installed and the build would give the target a real scheduler/network. Use a disposable project without it.', e;
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS cron;
CREATE SCHEMA IF NOT EXISTS net;
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE TABLE IF NOT EXISTS cron.job (
  jobid    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule text NOT NULL,
  command  text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT current_database(),
  username text NOT NULL DEFAULT current_user,
  active   boolean NOT NULL DEFAULT false,   -- INERT BY DEFAULT: never true on creation
  jobname  text UNIQUE
);
CREATE TABLE IF NOT EXISTS cron.job_run_details (
  runid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobid bigint, status text, start_time timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE id bigint;
BEGIN
  INSERT INTO cron.job (jobname, schedule, command, active) VALUES (job_name, schedule, command, false)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command, active = false
  RETURNING jobid INTO id;
  RETURN id;
END $$;
CREATE OR REPLACE FUNCTION cron.schedule(schedule text, command text)
RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN RETURN cron.schedule('unnamed-' || md5(schedule || command), schedule, command); END $$;
CREATE OR REPLACE FUNCTION cron.alter_job(
  job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cron.job j SET
    schedule = coalesce(alter_job.schedule, j.schedule),
    command  = coalesce(alter_job.command,  j.command),
    active   = false                              -- never re-activated here
  WHERE j.jobid = job_id;
END $$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE plpgsql AS $$ BEGIN DELETE FROM cron.job WHERE jobname = job_name; RETURN true; END $$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean
LANGUAGE plpgsql AS $$ BEGIN DELETE FROM cron.job WHERE jobid = job_id; RETURN true; END $$;

CREATE TABLE IF NOT EXISTS net.http_request_queue (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, url text);
CREATE TABLE IF NOT EXISTS net._http_response  (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text);
CREATE TABLE IF NOT EXISTS net.blocked_outbound_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), note text);

CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT NULL, params jsonb DEFAULT NULL,
                                         headers jsonb DEFAULT NULL, timeout_milliseconds integer DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN INSERT INTO net.blocked_outbound_attempts (note) VALUES ('http_post blocked'); RETURN 0; END $$;
CREATE OR REPLACE FUNCTION net.http_get(url text, params jsonb DEFAULT NULL, headers jsonb DEFAULT NULL,
                                        timeout_milliseconds integer DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN INSERT INTO net.blocked_outbound_attempts (note) VALUES ('http_get blocked'); RETURN 0; END $$;

-- ---------------------------------------------------------------------------
-- Platform surface the chain expects. On a real Supabase project these already
-- exist and these statements are no-ops (IF NOT EXISTS throughout); the local
-- harness needs them so the SAME artifact can drive both.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS vault;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY, email text, phone text, raw_user_meta_data jsonb,
  raw_app_meta_data jsonb, created_at timestamptz DEFAULT now(),
  email_confirmed_at timestamptz, last_sign_in_at timestamptz, deleted_at timestamptz);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz, path_tokens text[], version text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;

CREATE TABLE IF NOT EXISTS vault.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, secret text,
  created_at timestamptz DEFAULT now());
CREATE OR REPLACE VIEW vault.decrypted_secrets AS
  SELECT id, name, secret AS decrypted_secret, created_at FROM vault.secrets;
CREATE OR REPLACE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL,
                                               new_description text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE i uuid;
BEGIN INSERT INTO vault.secrets (name, secret) VALUES (new_name, new_secret)
      ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret RETURNING id INTO i; RETURN i; END $$;
CREATE OR REPLACE FUNCTION vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL,
                                               new_name text DEFAULT NULL, new_description text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN UPDATE vault.secrets SET secret = coalesce(new_secret, secret) WHERE id = secret_id; END $$;

-- realtime publication: migrations ALTER PUBLICATION supabase_realtime
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- A marker the wipe keys on, so clone_wipe.sql can prove it is looking at a
-- target this tooling built rather than at anything else.
CREATE TABLE IF NOT EXISTS net.rehearsal_target_marker (built_at timestamptz NOT NULL DEFAULT now());
INSERT INTO net.rehearsal_target_marker DEFAULT VALUES;

SELECT pg_temp.note('inert cron/net stand-ins installed; the sanitized chain will never install the real extensions');
