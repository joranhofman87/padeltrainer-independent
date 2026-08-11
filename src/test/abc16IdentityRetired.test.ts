// ABC-16 H0 — the academy Auth-email rewrite is retired at every layer.
//
// The defect needed three closures, because none of them covers the others:
//
//   SQL   `get_player_email_edit_capability` no longer returns 'direct'  (proved in
//         abc16MetadataAuthority.pglite.test.ts, against real PostgreSQL);
//   EDGE  the function holds the SERVICE ROLE, which is bound by neither RLS nor the profile
//         guard, so it must refuse on its own — proved here, by running the real handler;
//   UI    the client no longer offers the path at all — proved here.
//
// The Edge assertions are deliberately both BEHAVIOURAL (run the handler, inspect the
// response) and STRUCTURAL (the dangerous call and the service-role key do not appear in the
// module at all). Behaviour alone would let a future edit reintroduce a branch that this test
// happens not to reach; structure alone would not prove the refusal actually works.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EDGE_PATH = join(process.cwd(), 'supabase', 'functions', 'academy-update-player-email', 'index.ts');
const EDGE_SOURCE = readFileSync(EDGE_PATH, 'utf8');

describe('ABC-16 H0 · the Edge Function refuses, structurally', () => {
  it('contains no Auth admin mutation of any kind', () => {
    expect(EDGE_SOURCE).not.toMatch(/updateUserById/);
    expect(EDGE_SOURCE).not.toMatch(/auth\.admin/);
    expect(EDGE_SOURCE).not.toMatch(/email_confirm/);
  });

  it('never constructs a privileged client and never reads the service-role key', () => {
    // No client, no key, no branch to reach: the strongest available proof that the
    // service-role path is unreachable rather than merely unused.
    expect(EDGE_SOURCE).not.toMatch(/createClient/);
    expect(EDGE_SOURCE).not.toMatch(/SERVICE_ROLE/);
    expect(EDGE_SOURCE).not.toMatch(/from\(["']profiles["']\)/);
  });

  it('still declares the stable refusal code', () => {
    expect(EDGE_SOURCE).toMatch(/identity_is_self_service/);
  });
});

describe('ABC-16 H0 · the Edge Function refuses, behaviourally', () => {
  let handler: (req: Request) => Response | Promise<Response>;

  beforeAll(async () => {
    // The module registers its handler with Deno.serve at import time. Stub it to capture the
    // handler so the REAL shipped code runs here, rather than a copy of it.
    (globalThis as { Deno?: unknown }).Deno = {
      serve: (h: (req: Request) => Response | Promise<Response>) => { handler = h; },
    };
    await import(/* @vite-ignore */ EDGE_PATH);
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('https://example.test/academy-update-player-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('answers 403 identity_is_self_service for a fully-formed, authorized-looking request', async () => {
    const res = await handler(post(
      { profile_id: 'p-1', academy_profile_id: 'a-1', email: 'attacker@example.test' },
      { Authorization: 'Bearer some-token' },
    ));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('identity_is_self_service');
    expect(body.detail).toMatch(/only they can change it|player changes it themselves|own account/i);
  });

  it('the refusal is STABLE — identical for every caller and every input', async () => {
    const responses = await Promise.all([
      handler(post({})),
      handler(post({ profile_id: 'p-1' })),
      handler(post({ profile_id: 'p-2', academy_profile_id: 'a-2', email: 'x@y.test' }, { Authorization: 'Bearer other' })),
      handler(new Request('https://example.test/academy-update-player-email', { method: 'POST' })),
    ]);

    const seen = new Set<string>();
    for (const res of responses) {
      expect(res.status).toBe(403);
      seen.add(await res.text());
    }
    // One distinct body across every shape of request: nothing about the response can vary,
    // so nothing about it can leak whether a target exists or is nascent.
    expect(seen.size).toBe(1);
  });

  it('still answers the CORS preflight, so the browser reports the 403 instead of a CORS error', async () => {
    const res = await handler(new Request('https://example.test/academy-update-player-email', { method: 'OPTIONS' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('ABC-16 H0 · the client no longer offers the path', () => {
  it('emailBounce exports no direct-email writer at all', async () => {
    vi.resetModules();
    const mod = await import('@/lib/emailBounce');
    expect('updatePlayerEmailDirect' in mod).toBe(false);
    expect('usePlayerEmailEditCapability' in mod).toBe(false);
  });

  it('the billing-email override refuses without sending a request', async () => {
    vi.resetModules();
    const fromMock = vi.fn();
    vi.doMock('@/lib/supabaseClient', () => ({ supabase: { from: (t: string) => fromMock(t) } }));

    const { updateBillingEmailOverride } = await import('@/lib/emailBounce');
    const { isOverlayWriteDisabledError } = await import('@/lib/overlayWriteContainment');

    await expect(
      updateBillingEmailOverride({ academyProfileId: 'a-1', profileId: 'p-1', email: 'x@y.test' }),
    ).rejects.toSatisfy(isOverlayWriteDisabledError);

    expect(fromMock).not.toHaveBeenCalled();
  });

  it('the guest contact path is PRESERVED — it writes guest_players, not an overlay', async () => {
    vi.resetModules();
    const updated: Array<[string, unknown]> = [];
    vi.doMock('@/lib/supabaseClient', () => ({
      supabase: {
        from: (table: string) => ({
          update: (payload: unknown) => {
            updated.push([table, payload]);
            return { eq: () => Promise.resolve({ error: null }) };
          },
        }),
      },
    }));

    const { updateGuestEmail } = await import('@/lib/emailBounce');
    await updateGuestEmail('guest-1', '  New@Example.Test ');

    // guest_players write policies are ownership-based (academy owns the row, or an ACTIVE
    // academy trainer owns it — 20260224171306) and reference no overlay table, which is why
    // this path survives H0. It is also still normalized.
    expect(updated).toEqual([['guest_players', { email: 'new@example.test' }]]);
  });
});
