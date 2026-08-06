import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * `roleDataFailed` — the flag that tells a surface "the reads that decide AUTHORITY failed", as
 * distinct from `profileFetchFailed`, which aggregates four unrelated reads.
 *
 * It exists because `useAuth` PUBLISHES partial results on its final attempt: a failed
 * academy-manager lookup beside a successful roles lookup yields `isAcademyManager === false`
 * alongside real roles. A page that renders on that shows a manager the wrong content — a wrong
 * answer that looks like a complete one. Refusing on the aggregate instead would take a page down
 * for a profile or club-manager failure that cannot affect authority, so the two must stay
 * distinguishable.
 *
 * These assertions run against the REAL provider. The consumers mock `useAuth` wholesale, so
 * without this the wiring could be deleted and every other test would still pass.
 */

const USER = { id: 'U1', email: 'a@b.c' };

let rolesResult: { data: string[]; failed: boolean };
let profileResult: { data: unknown; failed: boolean };
let clubResult: { data: boolean; failed: boolean };
let academyResult: { data: boolean; failed: boolean };

vi.mock('@/lib/auth', () => ({
  getUserRoles: vi.fn(() => Promise.resolve(rolesResult)),
  getProfile: vi.fn(() => Promise.resolve(profileResult)),
}));
vi.mock('@/lib/club', () => ({ isUserClubManager: vi.fn(() => Promise.resolve(clubResult)) }));
vi.mock('@/lib/academy', () => ({
  isUserAcademyManager: vi.fn(() => Promise.resolve(academyResult)),
}));
vi.mock('@/lib/tracking', () => ({ identifyUser: vi.fn(), resetUser: vi.fn() }));
vi.mock('@/lib/subscriptionCache', () => ({
  logSubscriptionFallback: vi.fn(),
  readCachedSubscription: () => null,
  writeCachedSubscription: vi.fn(),
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { user: USER, access_token: 't' } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
    },
    functions: { invoke: () => Promise.resolve({ data: null, error: new Error('no subscription') }) },
  },
}));

import { AuthProvider, useAuth } from '@/hooks/useAuth';

function Probe() {
  const { profileReady, profileFetchFailed, roleDataFailed, roles, isAcademyManager } = useAuth();
  if (!profileReady) return <span data-testid="state">resolving</span>;
  return (
    <span data-testid="state">
      {`aggregate=${profileFetchFailed} roleData=${roleDataFailed} roles=${roles.join(',')} mgr=${isAcademyManager}`}
    </span>
  );
}

const ok = <T,>(data: T) => ({ data, failed: false });
const failed = <T,>(data: T) => ({ data, failed: true });

beforeEach(() => {
  rolesResult = ok(['trainer']);
  profileResult = ok({ id: 'U1' });
  clubResult = ok(false);
  academyResult = ok(true);
});

async function renderProbe() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('state')).not.toHaveTextContent('resolving'), {
    timeout: 10_000,
  });
  return screen.getByTestId('state').textContent ?? '';
}

describe('useAuth roleDataFailed', () => {
  it('is false when every read succeeds', async () => {
    expect(await renderProbe()).toContain('aggregate=false roleData=false');
  });

  it('is TRUE when the academy-manager read failed, even though roles arrived', async () => {
    // The dangerous shape: `isAcademyManager` is published as false, indistinguishable from a
    // real non-manager, while `roles` looks perfectly healthy.
    academyResult = failed(false);
    const state = await renderProbe();
    expect(state).toContain('roleData=true');
    expect(state).toContain('roles=trainer');
    expect(state).toContain('mgr=false');
  });

  it('is TRUE when the roles read failed', async () => {
    rolesResult = failed([]);
    expect(await renderProbe()).toContain('roleData=true');
  });

  it('is FALSE when only the profile read failed', async () => {
    // Authority is intact; a surface that refused here would be offline for no reason.
    profileResult = failed(null);
    const state = await renderProbe();
    expect(state).toContain('aggregate=true');
    expect(state).toContain('roleData=false');
  });

  it('is FALSE when only the club-manager read failed', async () => {
    clubResult = failed(false);
    const state = await renderProbe();
    expect(state).toContain('aggregate=true');
    expect(state).toContain('roleData=false');
  });

  it('is TRUE when the fetch throws outright and nothing is published', async () => {
    // Nothing was written, so `roles`/`isAcademyManager` keep whatever the previous attempt — or
    // the previous ACCOUNT — left behind. That state must never look authoritative.
    const { getUserRoles } = await import('@/lib/auth');
    vi.mocked(getUserRoles).mockRejectedValue(new Error('network down'));
    const state = await renderProbe();
    expect(state).toContain('aggregate=true');
    expect(state).toContain('roleData=true');
  });
});
