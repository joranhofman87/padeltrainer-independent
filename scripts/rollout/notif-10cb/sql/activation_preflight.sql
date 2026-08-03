-- 10c-b RU3 — the READ-ONLY dry run of the activation gate.
--
-- Same assertions the real activation runs, with nothing armed. An operator can run this at any
-- time to find out whether activation WOULD be allowed, without taking the row lock that
-- activate.sql holds or changing anything.
--
-- IT IS NOT THE GATE. Passing here and then arming in a separate statement is precisely the
-- time-of-check/time-of-use hole activate.sql exists to close: between the two, the job can be
-- replaced, re-pointed or deleted, and the arm-by-name would happily match whatever is there (or
-- nothing at all — `UPDATE ... WHERE` matching zero rows succeeds). Use `run-enablement.sh
-- activate`, which verifies and arms the SAME LOCKED ROW inside one transaction.
--
-- Takes :run_id — the uuid the CANARY invocation itself returned.
\set ON_ERROR_STOP on
\i ../../notif-10ca3/sql/_assert.sql
\i _activation_assertions.sql

SELECT pg_temp.note('PREFLIGHT ONLY — nothing was armed. The gate that arms is activate.sql, which re-runs every assertion above under a row lock in the same transaction as the arm.');
