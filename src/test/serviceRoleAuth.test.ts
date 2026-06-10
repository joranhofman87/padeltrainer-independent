import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildServiceRoleAuthDebug,
  extractBearerToken,
  isServiceRoleJwtForProject,
  isServiceRoleRequest,
  parseSupabaseJwtClaims,
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

  it('accepts matching service_role JWT in Authorization and apikey', () => {
    const jwt = makeJwt({ role: 'service_role', ref: 'myproject' });
    const req = new Request('http://localhost', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: jwt,
      },
    });
    expect(isServiceRoleRequest(req)).toBe(true);
    expect(resolveServiceRoleToken(req)).toBe(jwt);
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

describe('parseSupabaseJwtClaims', () => {
  it('reads role and ref from JWT payload', () => {
    const jwt = makeJwt({ role: 'service_role', ref: 'myproject' });
    expect(parseSupabaseJwtClaims(jwt)).toEqual({ role: 'service_role', ref: 'myproject' });
    expect(isServiceRoleJwtForProject(jwt)).toBe(true);
  });
});
