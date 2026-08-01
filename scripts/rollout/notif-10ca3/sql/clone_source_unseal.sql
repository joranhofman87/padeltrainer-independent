-- ===========================================================================
-- clone_source_unseal.sql — remove the provenance marker from PRODUCTION.
-- Run as part of resume, before production returns to normal operation. The
-- marker must not outlive the cloning window; clones keep their own copy.
-- ===========================================================================
\set ON_ERROR_STOP on
\ir _assert.sql
DROP TABLE IF EXISTS rollout_clone.snapshot_marker;
DROP SCHEMA IF EXISTS rollout_clone;
SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'rollout_clone') = 0,
  'the snapshot marker schema is gone from production');
