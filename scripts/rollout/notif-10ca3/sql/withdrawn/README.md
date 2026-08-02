# Withdrawn artifacts — retained for review, never executed

These two files implemented the sealed-window fence: statement triggers on
`cron.job` and `net.http_request_queue` that rejected every write for the
duration of a snapshot window.

**They are not part of the executable artifact set.** No code path in the rollout
bundle reads this directory (`verify/repo-guard-test.sh` asserts that, and also
asserts that no executable file anywhere creates a trigger on an extension table).

Why they were withdrawn — in full, with the threat model and the supported
replacement — is in [`../../docs/ADR-001-clone-safety-fence-withdrawn.md`](../../docs/ADR-001-clone-safety-fence-withdrawn.md).

In short:

* Supabase advises against triggers on `net.http_request_queue`, and a
  *deliberately failing* one especially, because it can disrupt pg_net:
  <https://supabase.com/docs/guides/troubleshooting/webhook-debugging-guide-M8sk47>
* `CREATE TRIGGER` needs the table's `TRIGGER` privilege; `DROP TRIGGER` needs
  **ownership**. These tables are extension-managed, so a `GRANT TRIGGER` yields
  a fence that can be installed and never removed by the same role.
* Production inventory (read-only, 2026-08-02) returned `FENCEABLE no`.

They are kept here, unmodified, so a future reviewer can see exactly what was
proposed and why it does not hold — not as something to re-enable.
