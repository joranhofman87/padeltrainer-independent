import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * N2 S5 — the public manage page.
 *
 * What must not regress:
 *  1. the token leaves the ADDRESS BAR before anything else happens (history sync, referrers and
 *     screenshots see the URL; no analytics filter touches those),
 *  2. an OPERATIONAL failure (503/network) renders retry — telling someone "this link is broken"
 *     while their opt-out was merely deferred sends them away and loses it,
 *  3. a dead link renders the friendly copy, not an error,
 *  4. apply happens only on the button — rendering the page must never unsubscribe by itself
 *     (link scanners follow hrefs; the ACTION needs a human).
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string | Record<string, unknown>) => {
      if (typeof def === 'object' && def !== null) {
        const template = String((def as Record<string, unknown>).defaultValue ?? key);
        return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String((def as Record<string, unknown>)[name] ?? ''));
      }
      return def ?? key;
    },
  }),
}));

import ManageEmail from '@/pages/ManageEmail';

const fetchMock = vi.fn();
let replaceStateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/manage-email?token=v1.abc.def');
  replaceStateSpy = vi.spyOn(window.history, 'replaceState');
});

afterEach(() => {
  vi.unstubAllGlobals();
  replaceStateSpy.mockRestore();
});

const jsonResponse = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('ManageEmail', () => {
  it('scrubs the token from the address bar, but still SENDS it to the API', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse(200, { status: 'live', scopeName: 'Padel Academy Zuid', destinationRedacted: 'p•••@e•••.com' }),
    );
    render(<ManageEmail />);
    await screen.findByTestId('manage-email-live');
    expect(window.location.search).not.toContain('token');
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toEqual({ op: 'context', token: 'v1.abc.def' });
  });

  it('renders the redacted context and applies ONLY on the button press', async () => {
    fetchMock.mockImplementationOnce(() =>
      jsonResponse(200, { status: 'live', scopeName: 'Padel Academy Zuid', destinationRedacted: 'p•••@e•••.com' }),
    );
    render(<ManageEmail />);
    await screen.findByTestId('manage-email-live');
    expect(screen.getByText(/Padel Academy Zuid/)).toBeInTheDocument();
    expect(screen.getByText(/p•••@e•••\.com/)).toBeInTheDocument();
    // Rendering alone must not have applied anything.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementationOnce(() => jsonResponse(200, { result: 'applied' }));
    screen.getByRole('button').click();
    await screen.findByTestId('manage-email-done');
    const applyCall = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(applyCall.op).toBe('apply');
  });

  it('already_applied renders as done, with the already-unsubscribed copy', async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse(200, { status: 'live', scopeName: 'X', destinationRedacted: 'y' }))
      .mockImplementationOnce(() => jsonResponse(200, { result: 'already_applied' }));
    render(<ManageEmail />);
    await screen.findByTestId('manage-email-live');
    screen.getByRole('button').click();
    await screen.findByTestId('manage-email-done');
    expect(screen.getByText(/already unsubscribed/)).toBeInTheDocument();
  });

  it('a dead link renders the friendly copy', async () => {
    for (const status of ['invalid', 'expired', 'revoked', 'missing', 'retired_key']) {
      fetchMock.mockImplementationOnce(() => jsonResponse(200, { status }));
      const { unmount } = render(<ManageEmail />);
      await screen.findByTestId('manage-email-dead');
      unmount();
    }
  });

  it('a 503 renders RETRY, never "link broken" — the opt-out was deferred, not lost', async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse(503, { error: 'temporarily_unavailable' }));
    render(<ManageEmail />);
    await screen.findByTestId('manage-email-operational');
    // and the retry actually retries
    fetchMock.mockImplementationOnce(() =>
      jsonResponse(200, { status: 'live', scopeName: 'X', destinationRedacted: 'y' }),
    );
    screen.getByRole('button').click();
    await screen.findByTestId('manage-email-live');
  });

  it('a network failure on APPLY lands on retry too, not on done and not on dead', async () => {
    fetchMock.mockImplementationOnce(() =>
      jsonResponse(200, { status: 'live', scopeName: 'X', destinationRedacted: 'y' }),
    );
    render(<ManageEmail />);
    await screen.findByTestId('manage-email-live');
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    screen.getByRole('button').click();
    await screen.findByTestId('manage-email-operational');
  });
});
