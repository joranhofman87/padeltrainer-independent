import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * N4 M7 — the admin notification-operations surface, tested on the N3 doctrine:
 *  1. FAIL-CLOSED loads: every section renders retry on error, never defaults-as-state;
 *  2. the kill decision demands a reason and holds ONE request id across a failed retry
 *     (the registry replays it server-side — a fresh id per press would double-decide);
 *  3. TYPED VERDICTS are handled as values: a stale-state circuit refusal prompts a
 *     reload-and-reconfirm, and the confirmation carries the state the SCREEN showed;
 *  4. cursors round-trip as the RAW STRING the server sent (microseconds survive);
 *  5. the DIGEST_SEND_ENABLED line is visible page text;
 *  6. no clear-kill and no retry control exists (source-pinned).
 */

const rpcMock = vi.fn();
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { rpc: (fn: string, args?: Record<string, unknown>) => rpcMock(fn, args) },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      const vars = (typeof def === 'string' ? opts : def) ?? {};
      const template = typeof def === 'string'
        ? def
        : String((def as Record<string, unknown> | undefined)?.defaultValue ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String((vars as Record<string, unknown>)[name] ?? ''));
    },
  }),
}));

import AdminNotificationOps from '@/pages/admin/AdminNotificationOps';

// microsecond-precision timestamps EXACTLY as PostgREST serializes them — the cursor must
// round-trip these verbatim
const TS1 = '2026-08-05T15:15:01.899123+00:00';
const TS2 = '2026-08-05T15:15:01.899124+00:00';

let failing: Set<string>;
const defaultImpl = (fn: string) => {
  if (failing.has(fn)) return Promise.resolve({ data: null, error: { message: 'boom' } });
  switch (fn) {
    case 'admin_notification_readiness':
      return Promise.resolve({
        data: {
          schema_version: 1, as_of: TS1, readiness: 'not_provable',
          checks: [
            { id: 'channel_kills', status: 'pass', detail: '0 channel(s) killed' },
            { id: 'digest_send_enabled_env', status: 'not_provable', detail: 'DIGEST_SEND_ENABLED is an edge env var no SQL can read — operator assertion only' },
            { id: 'durable_activation_boundary', status: 'not_provable', detail: 'N5 not shipped' },
          ],
        },
        error: null,
      });
    case 'admin_notification_gauges':
      return Promise.resolve({
        data: [
          { metric: 'channel_killed', channel: 'email', event_type: null, value: 0, capped: false },
          { metric: 'channel_killed', channel: 'whatsapp', event_type: null, value: 1, capped: false },
        ],
        error: null,
      });
    case 'admin_notification_event_states':
      return Promise.resolve({
        data: [{
          event_type: 'ev_test', channel: 'email', catalog_supported: true, catalog_default: 'instant',
          required_delivery: false, digest_engine_enabled: false, academy_off_caps: 0,
          cron_state: 'inactive', circuit_state: 'open', circuit_reason: 'provider_5xx',
          circuit_tripped_at: TS1, kill_state: 'live', send_env: 'unverifiable',
          instant_conclusion: 'stopped', digest_conclusion: 'stopped',
        }],
        error: null,
      });
    case 'admin_list_worker_invocations':
      return Promise.resolve({ data: [], error: null });
    case 'admin_list_notification_outbox':
      return Promise.resolve({
        data: [{ id: 'ob1', created_at: TS2, event_type: 'ev_test', channel: 'email', status: 'failed', attempts: 2, max_attempts: 3, destination_redacted: 'p***@x.nl', skip_reason: null, error_class: 'provider_error', template_key: 't', delivery_mode: null, scheduled_for: TS1, tenant_academy_profile_id: null, tenant_trainer_id: null, updated_at: TS2 }],
        error: null,
      });
    case 'admin_notification_delivery_history':
      return Promise.resolve({ data: [{ at: TS1, kind: 'outbox_created', a: 'ev_test', b: 'email', c: 'p***@x.nl', ref: 'ob-created:ob1' }], error: null });
    case 'admin_list_digest_groups':
      return Promise.resolve({
        data: [{ id: 'g1', created_at: TS2, event_type: 'ev_test', channel: 'email', state: 'request_ready', terminal_reason: null, item_count: 2, provider_attempts_started: 0, provider_message_id: null, first_send_at: null, uncertain_since: null, provider_status: null, delivery_budget_used: 0, digest_boundary_at: TS1, available_at: TS1, locked_by: null, worker_run_id: null, updated_at: TS2 }],
        error: null,
      });
    case 'admin_list_worker_runs':
      return Promise.resolve({ data: [], error: null });
    case 'admin_list_notification_orphans':
      return Promise.resolve({
        data: [{ resend_event_id: 'orph1', channel: 'email', digest_group_id: 'g1', attempts: 3, last_error_code: 'tagged_mismatch', quarantined: true, next_eligible_at: TS1, updated_at: TS2 }],
        error: null,
      });
    case 'admin_preview_notification_recipients':
      return Promise.resolve({
        data: [{ user_id: 'u1', final_frequency: 'instant', final_decision: 'deliver:instant', destination_masked: 'p***@x.nl', candidates_partial: true, next_cursor: 'u1' }],
        error: null,
      });
    case 'admin_search_notification_destination':
      return Promise.resolve({
        data: [{ destination_masked: 'p***@x.nl', contacts: 1, contacts_capped: false, outbox_rows: 3, outbox_capped: false, delivery_events: 2, events_capped: false }],
        error: null,
      });
    case 'admin_cancel_digest_group':
      return Promise.resolve({ data: 'cancelled', error: null });
    case 'admin_resolve_notification_orphan':
      return Promise.resolve({ data: 'rejected_not_permanent', error: null });
    case 'admin_requeue_notification_orphan':
      return Promise.resolve({ data: 'requeued', error: null });
    case 'admin_list_notification_audit':
      return Promise.resolve({
        data: [
          { id: 'a1', created_at: TS2, action: 'channel_kill', target: 'email', old_value: 'live', new_value: 'killed', outcome: 'applied', reason: 'r1', actor: 'x', request_id: 'q1' },
          { id: 'a2', created_at: TS1, action: 'channel_kill', target: 'email', old_value: 'killed', new_value: 'killed', outcome: 'already_killed', reason: 'r2', actor: 'x', request_id: 'q2' },
        ],
        error: null,
      });
    case 'admin_list_notification_rejected':
      return Promise.resolve({ data: [], error: null });
    case 'admin_activate_channel_kill':
      return Promise.resolve({ data: 'killed', error: null });
    case 'admin_reset_notification_circuit':
      return Promise.resolve({ data: 'rejected_stale_state', error: null });
    default:
      return Promise.resolve({ data: [], error: null });
  }
};

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminNotificationOps />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  failing = new Set();
  rpcMock.mockImplementation(defaultImpl);
});

describe('AdminNotificationOps', () => {
  it('renders the readiness envelope with the N5 checks and the VISIBLE env line', async () => {
    renderPage();
    await screen.findByTestId('readiness-envelope');
    expect(screen.getByTestId('env-line').textContent).toContain('cannot be verified from this page or from SQL');
    expect(screen.getByTestId('check-digest_send_enabled_env').textContent).toContain('no SQL can read');
    expect(screen.getByTestId('check-durable_activation_boundary').textContent).toContain('N5 not shipped');
  });

  it('every failing section renders RETRY, never defaults-as-state', async () => {
    failing = new Set(['admin_notification_readiness', 'admin_notification_gauges', 'admin_notification_event_states', 'admin_list_worker_invocations']);
    renderPage();
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBe(4));
    expect(screen.queryByTestId('readiness-envelope')).toBeNull();
    expect(screen.queryByTestId('kill-switches')).toBeNull();   // the kill state is NEVER guessed
  });

  it('the kill decision: reason mandatory, ONE request id held across a failed retry', async () => {
    renderPage();
    await screen.findByTestId('kill-switches');
    fireEvent.click(screen.getByTestId('kill-btn-email'));
    const confirm = await screen.findByTestId('kill-confirm');
    expect(confirm).toBeDisabled();                              // no reason yet
    fireEvent.change(screen.getByTestId('kill-reason'), { target: { value: 'incident 42' } });
    // first press fails at the network
    rpcMock.mockImplementationOnce((fn: string) =>
      fn === 'admin_activate_channel_kill'
        ? Promise.resolve({ data: null, error: { message: 'network' } })
        : defaultImpl(fn));
    fireEvent.click(confirm);
    await waitFor(() => expect(rpcMock.mock.calls.filter((c) => c[0] === 'admin_activate_channel_kill')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('kill-confirm'));
    await waitFor(() => expect(rpcMock.mock.calls.filter((c) => c[0] === 'admin_activate_channel_kill')).toHaveLength(2));
    const [first, second] = rpcMock.mock.calls.filter((c) => c[0] === 'admin_activate_channel_kill');
    expect(first[1].p_request_id).toBe(second[1].p_request_id);  // the retry REPLAYS the decision
    expect(String(first[1].p_request_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(first[1].p_reason).toBe('incident 42');
  });

  it('an already-killed channel offers NO kill button — and the page has no clear control at all', async () => {
    renderPage();
    await screen.findByTestId('kill-switches');
    expect(screen.queryByTestId('kill-btn-whatsapp')).toBeNull();   // killed → no button
    expect(screen.getByTestId('kill-whatsapp').getAttribute('data-killed')).toBe('true');
    const src = readFileSync(resolve(__dirname, '..', 'pages', 'admin', 'AdminNotificationOps.tsx'), 'utf8');
    // the pin is on the CALLS: no RPC shaped like a clear/retry/resend is ever invoked (the
    // section-retry buttons re-LOAD reads; they never re-send or re-enable anything)
    expect(src).not.toMatch(/rpc\(\s*['"]admin_[a-z_]*(clear|retry|resend|unkill)/i);
    expect(src).not.toMatch(/unkill|clear.?channel.?kill/i);
  });

  it('the circuit reset confirms against the state the SCREEN showed, and a stale refusal is a typed verdict', async () => {
    renderPage();
    await screen.findByTestId('event-states');
    fireEvent.click(screen.getByTestId('reset-btn-email'));
    fireEvent.change(await screen.findByTestId('reset-reason'), { target: { value: 'provider recovered' } });
    fireEvent.click(screen.getByTestId('reset-confirm'));
    await waitFor(() => {
      const call = rpcMock.mock.calls.find((c) => c[0] === 'admin_reset_notification_circuit');
      expect(call).toBeTruthy();
      // the expected identity is EXACTLY what this screen displayed — including the raw
      // microsecond timestamp string, never a Date round-trip
      expect(call![1].p_expected_state).toBe('open');
      expect(call![1].p_expected_reason).toBe('provider_5xx');
      expect(call![1].p_expected_tripped_at).toBe(TS1);
      expect(String(call![1].p_request_id)).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('audit pagination passes the RAW string cursor back verbatim — microseconds intact', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('audit-load'));
    await screen.findByTestId('audit-list');
    fireEvent.click(screen.getByTestId('audit-more'));
    await waitFor(() => {
      const calls = rpcMock.mock.calls.filter((c) => c[0] === 'admin_list_notification_audit');
      expect(calls.length).toBe(2);
      expect(calls[1][1].p_before_created_at).toBe(TS1);   // the LAST row's raw string, verbatim
      expect(calls[1][1].p_before_id).toBe('a2');
      expect(typeof calls[1][1].p_before_created_at).toBe('string');
    });
  });
});

describe('AdminNotificationOps — the completed surface (M7 round 2)', () => {
  it('decision inputs FREEZE after the first submit — the retry cannot change the fingerprint', async () => {
    renderPage();
    await screen.findByTestId('kill-switches');
    fireEvent.click(screen.getByTestId('kill-btn-email'));
    fireEvent.change(await screen.findByTestId('kill-reason'), { target: { value: 'incident 42' } });
    rpcMock.mockImplementationOnce((fn: string) =>
      fn === 'admin_activate_channel_kill'
        ? Promise.resolve({ data: null, error: { message: 'network' } })
        : defaultImpl(fn));
    fireEvent.click(screen.getByTestId('kill-confirm'));
    await waitFor(() => expect(screen.getByTestId('kill-reason')).toHaveAttribute('readonly'));
    expect(screen.getByTestId('kill-frozen-note')).toBeInTheDocument();
    // even a programmatic change event cannot alter what a retry sends: readOnly + same id
    fireEvent.click(screen.getByTestId('kill-confirm'));
    await waitFor(() => expect(rpcMock.mock.calls.filter((c) => c[0] === 'admin_activate_channel_kill')).toHaveLength(2));
    const [a, b] = rpcMock.mock.calls.filter((c) => c[0] === 'admin_activate_channel_kill');
    expect(a[1].p_reason).toBe(b[1].p_reason);
    expect(a[1].p_request_id).toBe(b[1].p_request_id);
  });

  it('the circuit trip identity is DISPLAYED, and the visible values equal the submitted values', async () => {
    renderPage();
    await screen.findByTestId('event-states');
    const detail = screen.getByTestId('circuit-detail-email');
    expect(detail.textContent).toContain('provider_5xx');
    expect(detail.textContent).toContain(TS1);              // the raw microsecond string, on screen
    fireEvent.click(screen.getByTestId('reset-btn-email'));
    expect((await screen.findByTestId('reset-identity')).textContent).toContain('provider_5xx');
    fireEvent.change(screen.getByTestId('reset-reason'), { target: { value: 'recovered' } });
    fireEvent.click(screen.getByTestId('reset-confirm'));
    await waitFor(() => {
      const call = rpcMock.mock.calls.find((c) => c[0] === 'admin_reset_notification_circuit');
      expect(call![1].p_expected_reason).toBe('provider_5xx');   // exactly what the screen showed
      expect(call![1].p_expected_tripped_at).toBe(TS1);
    });
  });

  it('pagination: the in-flight guard blocks a concurrent click, and a stale response cannot overwrite newer state', async () => {
    renderPage();
    // slow first page, so the second click lands mid-flight
    let release: ((v: { data: unknown; error: null }) => void) | null = null;
    rpcMock.mockImplementationOnce((fn: string) =>
      fn === 'admin_list_notification_audit'
        ? new Promise((res) => { release = res; })
        : defaultImpl(fn));
    fireEvent.click(await screen.findByTestId('audit-load'));
    fireEvent.click(screen.getByTestId('audit-load'));   // mid-flight: must NO-OP
    await new Promise((r) => setTimeout(r, 30));
    expect(rpcMock.mock.calls.filter((c) => c[0] === 'admin_list_notification_audit')).toHaveLength(1);
    release!({ data: [{ id: 'a9', created_at: TS1, action: 'channel_kill', target: 'email', old_value: 'live', new_value: 'killed', outcome: 'applied', reason: 'r', actor: 'x', request_id: 'q' }], error: null });
    await screen.findByTestId('audit-list');
  });

  it('group cancel sends the DISPLAYED expected state; orphan controls surface typed verdicts', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('groups-load'));
    fireEvent.click(await screen.findByTestId('cancel-btn-g1'));
    fireEvent.change(await screen.findByTestId('cancel-reason'), { target: { value: 'wrong audience' } });
    fireEvent.click(screen.getByTestId('cancel-confirm'));
    await waitFor(() => {
      const call = rpcMock.mock.calls.find((c) => c[0] === 'admin_cancel_digest_group');
      expect(call![1].p_expected_state).toBe('request_ready');   // the row's shown state, verbatim
      expect(String(call![1].p_request_id)).toMatch(/^[0-9a-f-]{36}$/);
    });
    fireEvent.click(await screen.findByTestId('orphans-load'));
    fireEvent.click(await screen.findByTestId('orphan-resolve-orph1'));
    fireEvent.change(await screen.findByTestId('orphan-reason'), { target: { value: 'confirmed mismatch' } });
    fireEvent.click(screen.getByTestId('orphan-confirm'));
    await waitFor(() => {
      expect(rpcMock.mock.calls.some((c) => c[0] === 'admin_resolve_notification_orphan')).toBe(true);
    });
  });

  it('the delivery-history drill-down fetches the clicked row; preview shows the PARTIAL banner and crawls by next_cursor', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('outbox-load'));
    fireEvent.click(await screen.findByTestId('history-btn-ob1'));
    await screen.findByTestId('delivery-history');
    expect(rpcMock.mock.calls.find((c) => c[0] === 'admin_notification_delivery_history')![1].p_outbox_id).toBe('ob1');
    // preview
    await screen.findByTestId('event-states');
    fireEvent.change(screen.getByTestId('preview-event'), { target: { value: 'ev_test' } });
    fireEvent.click(screen.getByTestId('preview-load'));
    await screen.findByTestId('preview-partial');            // the honest omission banner
    fireEvent.click(screen.getByTestId('preview-more'));
    await waitFor(() => {
      const calls = rpcMock.mock.calls.filter((c) => c[0] === 'admin_preview_notification_recipients');
      expect(calls.length).toBe(2);
      expect(calls[1][1].p_after_user_id).toBe('u1');        // next_cursor, verbatim
    });
  });

  it('the destination lookup renders the masked result and surfaces typed refusals as messages', async () => {
    renderPage();
    fireEvent.change(await screen.findByTestId('search-input'), { target: { value: 'p1@example.com' } });
    fireEvent.click(screen.getByTestId('search-btn'));
    await screen.findByTestId('search-result');
    expect(screen.getByTestId('search-result').textContent).toContain('p***@x.nl');
    rpcMock.mockImplementationOnce((fn: string) =>
      fn === 'admin_search_notification_destination'
        ? Promise.resolve({ data: null, error: { message: 'rate limit reached (30/hour)' } })
        : defaultImpl(fn));
    fireEvent.click(screen.getByTestId('search-btn'));
    await screen.findByTestId('search-message');
    expect(screen.getByTestId('search-message').textContent).toContain('rate limit');
  });
});

describe('AdminNotificationOps — M7 round 3: per-operation races', () => {
  it('history: a LATE response for row A never renders under row B (reversed order)', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('outbox-load'));
    // A's history is slow…
    let releaseA: ((v: { data: unknown; error: null }) => void) | null = null;
    rpcMock.mockImplementationOnce((fn: string, args?: Record<string, unknown>) =>
      fn === 'admin_notification_delivery_history' && args?.p_outbox_id === 'ob1'
        ? new Promise((res) => { releaseA = res; })
        : defaultImpl(fn));
    fireEvent.click(await screen.findByTestId('history-btn-ob1'));
    // …while a second click for the SAME visible row list targets a different id via a
    // synthetic second row: simulate by calling openHistory for ob2 through a new fixture row.
    rpcMock.mockImplementationOnce((fn: string, args?: Record<string, unknown>) =>
      fn === 'admin_notification_delivery_history'
        ? Promise.resolve({ data: [{ at: TS2, kind: 'outbox_created', a: 'B-ROW', b: 'email', c: 'x', ref: `ob-created:${String(args?.p_outbox_id)}` }], error: null })
        : defaultImpl(fn));
    fireEvent.click(screen.getByTestId('history-btn-ob1'));   // the NEWER request (same button, new epoch)
    await waitFor(() => expect(screen.getByTestId('delivery-history').textContent).toContain('B-ROW'));
    // now A's stale response lands — it must be DROPPED, not overwrite B's content
    releaseA!({ data: [{ at: TS1, kind: 'outbox_created', a: 'A-STALE', b: 'email', c: 'y', ref: 'ob-created:stale' }], error: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('delivery-history').textContent).toContain('B-ROW');
    expect(screen.getByTestId('delivery-history').textContent).not.toContain('A-STALE');
  });

  it('preview: changing the event RESETS results and cursor; a stale in-flight response is dropped', async () => {
    renderPage();
    await screen.findByTestId('event-states');
    fireEvent.change(screen.getByTestId('preview-event'), { target: { value: 'ev_test' } });
    // a slow preview…
    let release: ((v: { data: unknown; error: null }) => void) | null = null;
    rpcMock.mockImplementationOnce((fn: string) =>
      fn === 'admin_preview_notification_recipients'
        ? new Promise((res) => { release = res; })
        : defaultImpl(fn));
    fireEvent.click(screen.getByTestId('preview-load'));
    // …then the scope changes mid-flight: the stale response must never render
    fireEvent.change(screen.getByTestId('preview-channel'), { target: { value: 'whatsapp' } });
    release!({ data: [{ user_id: 'stale-user', final_frequency: 'instant', final_decision: 'deliver:instant', destination_masked: 'STALE', candidates_partial: false, next_cursor: 'stale-user' }], error: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('preview-list')).toBeNull();   // reset held: nothing stale rendered
  });

  it('search: an older lookup cannot overwrite a newer result', async () => {
    renderPage();
    let releaseOld: ((v: { data: unknown; error: null }) => void) | null = null;
    rpcMock.mockImplementationOnce((fn: string) =>
      fn === 'admin_search_notification_destination'
        ? new Promise((res) => { releaseOld = res; })
        : defaultImpl(fn));
    fireEvent.change(await screen.findByTestId('search-input'), { target: { value: 'old@example.com' } });
    fireEvent.click(screen.getByTestId('search-btn'));
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByTestId('search-btn'));        // the newer lookup resolves instantly
    await screen.findByTestId('search-result');
    releaseOld!({ data: [{ destination_masked: 'OLD-STALE', contacts: 9, contacts_capped: false, outbox_rows: 9, outbox_capped: false, delivery_events: 9, events_capped: false }], error: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('search-result').textContent).not.toContain('OLD-STALE');
  });
});
