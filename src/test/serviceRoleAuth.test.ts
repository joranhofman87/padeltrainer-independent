import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildServiceRoleAuthDebug,
  extractBearerToken,
  isServiceRoleRequest,
  resolveServiceRoleToken,
} from '../../supabase/functions/_shared/service-role-auth.ts';

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-sig`;
}

const envBackup = { ...process.env };

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_URL = 'https://myproject.supabase.co';
  // @ts-expect-error vitest shim for edge shared modules
  globalThis.Deno = {
    env: {
      get: (key: string) => process.env[key],
    },
  };
});

afterEach(() => {
  process.env = { ...envBackup };
});

describe('extractBearerToken', () => {
  it('parses case-insensitive Bearer prefix', () => {
    expect(extractBearerToken('bearer  abc123  ')).toBe('abc123');
  });
});

describe('isServiceRoleRequest', () => {
  it('accepts Authorization bearer matching env key', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer test-service-role-key' },
    });
    expect(isServiceRoleRequest(req)).toBe(true);
  });

  it('accepts apikey header matching env key', () => {
    const req = new Request('http://localhost', {
      headers: { apikey: 'test-service-role-key' },
    });
    expect(isServiceRoleRequest(req)).toBe(true);
  });

  it('accepts bare (non-Bearer) Authorization value matching env key', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'test-service-role-key' },
    });
    expect(isServiceRoleRequest(req)).toBe(true);
    expect(resolveServiceRoleToken(req)).toBe('test-service-role-key');
  });

  // P0 regression: a forged, unsigned service_role JWT (correct role + project ref)
  // supplied as bearer == apikey must NEVER be trusted. It is not the env key, so
  // there is no signature-free path to service-role privilege.
  it('REJECTS a forged service_role JWT even with the correct project ref', () => {
    const jwt = makeJwt({ role: 'service_role', ref: 'myproject' });
    const req = new Request('http://localhost', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: jwt,
      },
    });
    expect(isServiceRoleRequest(req)).toBe(false);
    expect(resolveServiceRoleToken(req)).toBeNull();
  });

  it('resolveServiceRoleToken returns the env key (never the request token) on match', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer test-service-role-key', apikey: 'test-service-role-key' },
    });
    expect(resolveServiceRoleToken(req)).toBe('test-service-role-key');
  });

  it('rejects anon JWT without env match', () => {
    const jwt = makeJwt({ role: 'anon', ref: 'myproject' });
    const req = new Request('http://localhost', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: jwt,
      },
    });
    expect(isServiceRoleRequest(req)).toBe(false);
  });

  it('rejects missing auth', () => {
    expect(isServiceRoleRequest(new Request('http://localhost'))).toBe(false);
  });
});

describe('buildServiceRoleAuthDebug', () => {
  it('reports safe debug fields without token values', () => {
    const req = new Request('http://localhost', {
      headers: {
        Authorization: 'Bearer test-service-role-key',
        apikey: 'test-service-role-key',
      },
    });
    const debug = buildServiceRoleAuthDebug(req);
    expect(debug).toEqual({
      hasAuthorizationHeader: true,
      hasApiKeyHeader: true,
      authHeaderStartsWithBearer: true,
      tokenLength: 'test-service-role-key'.length,
      apiKeyLength: 'test-service-role-key'.length,
      envServiceRoleKeyExists: true,
      envServiceRoleKeyLength: 'test-service-role-key'.length,
      tokenEqualsServiceRoleKey: true,
      apiKeyEqualsServiceRoleKey: true,
    });
    expect(JSON.stringify(debug)).not.toContain('test-service-role-key');
  });
});
