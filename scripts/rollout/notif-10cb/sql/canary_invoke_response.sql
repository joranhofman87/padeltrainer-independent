-- 10c-b RU2 — read the reply to the canary invocation. READ-ONLY, and takes :request_id, the pg_net
-- request id canary_invoke.sql printed.
--
-- WHY IT IS A SEPARATE ARTIFACT. pg_net is asynchronous by construction: net.http_post enqueues
-- inside the caller's transaction and the request is only dispatched once that transaction COMMITS,
-- with the reply landing in net._http_response afterwards. So the invocation cannot report its own
-- result, and an artifact that claimed to would be printing a response that had not happened.
--
-- IT RAISES WHILE THE REPLY IS STILL OUTSTANDING, so the caller can poll it on a bounded loop. That
-- is the ONLY condition it treats as an error: a non-200, or a transport failure, is information the
-- operator needs in full, not something to hide behind a failed script.
\set ON_ERROR_STOP on
\i ../../notif-10ca3/sql/_assert.sql

SELECT pg_temp.assert(
  (SELECT count(*) = 1 FROM net._http_response WHERE id = :'request_id'::bigint),
  'the pg_net reply for this request has arrived (still outstanding — poll again)');

-- For a human: the whole row, unabridged.
SELECT id, status_code, error_msg, content
  FROM net._http_response WHERE id = :'request_id'::bigint;

-- For run-enablement.sh: one line per fact, newlines collapsed so a multi-line transport error
-- cannot break the marker into pieces the caller would then read as separate records.
SELECT format('CANARY_RESPONSE_STATUS=%s', coalesce(status_code::text, 'none')) AS canary_marker
  FROM net._http_response WHERE id = :'request_id'::bigint
UNION ALL
SELECT format('CANARY_RESPONSE_ERROR=%s',
              coalesce(nullif(regexp_replace(error_msg, '[\r\n]+', ' ', 'g'), ''), 'none'))
  FROM net._http_response WHERE id = :'request_id'::bigint
UNION ALL
SELECT format('CANARY_RESPONSE_BODY=%s',
              coalesce(nullif(regexp_replace(content, '[\r\n]+', ' ', 'g'), ''), 'none'))
  FROM net._http_response WHERE id = :'request_id'::bigint;
