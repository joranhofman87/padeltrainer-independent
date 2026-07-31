-- Portable assertion helpers for the 10c-a3 rollout artifacts.
-- Included at the top of every artifact (psql: \i; local harness: inlined).
--
-- Works identically under `psql -v ON_ERROR_STOP=1` (a raised exception aborts
-- the script with a non-zero exit) and under the node-pg verification harness
-- (a raised exception rejects the query promise). Temp functions live only for
-- the session and never touch the target schema.
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'ASSERT FAILED: %', msg;
  END IF;
  RAISE NOTICE 'ok: %', msg;
END $$;

-- assert a scalar count/expression equals an expected value, with evidence.
CREATE OR REPLACE FUNCTION pg_temp.assert_eq(actual anyelement, expected anyelement, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'ASSERT FAILED: % (actual=% expected=%)', msg, actual, expected;
  END IF;
  RAISE NOTICE 'ok: % (= %)', msg, actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.note(msg text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'note: %', msg; END $$;
