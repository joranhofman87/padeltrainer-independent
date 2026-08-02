-- ===========================================================================
-- cron_noop_shim.sql — make the schema build INERT WHILE IT RUNS.
--
-- 14 migrations on main call cron.schedule, and some bake a hard-coded function
-- endpoint into the job's command. Deactivating jobs AFTER `supabase db push`
-- is too late: between the CREATE and the deactivation there is a live, active
-- job on a project we do not control the scheduler of.
--
-- So the shim is installed BEFORE the first migration runs. It provides a `cron`
-- schema whose schedule/alter_job/unschedule RECORD INTENT and execute nothing.
-- A migration's scheduling call therefore succeeds (the build proceeds exactly as
-- it would in production) while never producing anything that can fire.
--
-- FAIL CLOSED: if the real pg_cron extension is present we cannot shadow it, so
-- this refuses. A rehearsal target must be a project WITHOUT pg_cron — which an
-- empty project is, and which clone-verify-empty already reports.
--
-- The same argument applies to pg_net: a migration that calls net.http_post at
-- load time must not reach the network, so an inert net shim is installed too
-- when the real extension is absent.
-- ===========================================================================
\ir _assert.sql

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is INSTALLED on this target, so the scheduling shim cannot be installed and the schema build would create live jobs. Use a disposable project without pg_cron.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_net is INSTALLED on this target, so the outbound shim cannot be installed and a migration could reach the network during the build. Use a disposable project without pg_net.';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS cron;
CREATE SCHEMA IF NOT EXISTS net;

-- Everything a migration might schedule is recorded here instead of scheduled.
-- The rehearsal can then report exactly what production WOULD have running,
-- without anything running.
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
  RAISE NOTICE 'cron shim: recorded (never scheduled) job %', job_name;
  RETURN id;
END $$;

CREATE OR REPLACE FUNCTION cron.schedule(schedule text, command text)
RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN RETURN cron.schedule('unnamed-' || md5(schedule || command), schedule, command); END $$;

CREATE OR REPLACE FUNCTION cron.schedule_in_database(
  job_name text, schedule text, command text, database text,
  username text DEFAULT NULL, active boolean DEFAULT true)
RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN RETURN cron.schedule(job_name, schedule, command); END $$;

-- alter_job may only ever move a job TOWARDS inert on a rehearsal target
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

-- pg_net: record the intent, reach nothing. The queue stays EMPTY by
-- construction, which is what every downstream inertness check asserts.
CREATE TABLE IF NOT EXISTS net.http_request_queue (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, url text);
CREATE TABLE IF NOT EXISTS net._http_response  (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text);
CREATE TABLE IF NOT EXISTS net.blocked_outbound_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), note text);

CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT NULL, params jsonb DEFAULT NULL,
                                         headers jsonb DEFAULT NULL, timeout_milliseconds integer DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO net.blocked_outbound_attempts (note) VALUES ('http_post blocked by the rehearsal shim');
  RETURN 0;
END $$;
CREATE OR REPLACE FUNCTION net.http_get(url text, params jsonb DEFAULT NULL, headers jsonb DEFAULT NULL,
                                        timeout_milliseconds integer DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO net.blocked_outbound_attempts (note) VALUES ('http_get blocked by the rehearsal shim');
  RETURN 0;
END $$;

SELECT pg_temp.note('inert cron/pg_net shims installed BEFORE the schema build: scheduling is recorded, never scheduled; outbound calls are counted, never made');
