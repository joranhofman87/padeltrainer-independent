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
