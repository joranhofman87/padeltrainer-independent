-- N4 M1 (Stage-3.5 AC-6): REFUSE while any deliberate invocation is unresolved. Shared by
-- smoke_invoke / canary_invoke (before they open their own) and activate (which opens none —
-- arming must never ride over an unverified invocation's evidence window). The table is the
-- durable record that a request is TRAVELLING — pg_net's queue row disappears on pg_net's own
-- schedule, so this is the only honest "nothing is in flight".
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_invocations
    WHERE status IN ('pending', 'started')), 0,
  'no deliberate worker invocation is unresolved (one is pending or started — reconcile it, or resolve/abandon via the invocation RPCs, before proceeding)');
