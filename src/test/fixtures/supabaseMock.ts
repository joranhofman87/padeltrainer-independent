/**
 * Phase 4 F1 — a small, controllable Supabase query mock for characterization tests.
 *
 * It is a *smart* mock: you give it rows per table and it actually applies `.eq()` / `.in()` filters,
 * so a test exercises the real lib query shape (not a hand-fed return). Terminal forms: `await`
 * (PostgREST-style `{ data, error }`), `.maybeSingle()`, `.single()`. RPCs are handler functions.
 *
 * Usage:
 *   import { supabaseMock, setMockData } from './fixtures/supabaseMock';
 *   vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
 *   beforeEach(() => setMockData({ bookings: [...] }, { my_rpc: (args) => ({ data: 1 }) }));
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;
type RpcHandler = (args: any) => { data?: any; error?: any };

let _data: Record<string, Row[]> = {};
let _rpc: Record<string, RpcHandler> = {};

/** Configure the rows each table returns + optional rpc handlers (call in beforeEach). */
export function setMockData(data: Record<string, Row[]>, rpc: Record<string, RpcHandler> = {}): void {
  _data = data;
  _rpc = rpc;
}

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const applied = (): Row[] => (_data[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const result = () => ({ data: applied(), error: null });
  const first = () => ({ data: applied()[0] ?? null, error: null });

  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return api;
    },
    neq: (col: string, val: unknown) => {
      filters.push((r) => r[col] !== val);
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      const set = new Set(vals);
      filters.push((r) => set.has(r[col]));
      return api;
    },
    not: (col: string, _op: string, vals: unknown[]) => {
      // supports the `.not('status','in','(a,b)')` shape used by some queries
      const set = new Set(Array.isArray(vals) ? vals : [vals]);
      filters.push((r) => !set.has(r[col]));
      return api;
    },
    order: () => api,
    limit: () => api,
    maybeSingle: () => Promise.resolve(first()),
    single: () => Promise.resolve(first()),
    // make the builder awaitable → `{ data, error }`
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve(result()).then(resolve),
  };
  return api;
}

/**
 * Built-in defaults for definer RPCs that stand in for an RLS-blocked client read, so tests can
 * keep feeding the underlying table fixtures. get_cycle_roster_names resolves participant names
 * server-side (bypassing the academy manager's inability to read `profiles`) — model it as the
 * union of the profiles + guest_players fixtures, exactly what the SQL returns. An explicitly
 * passed `_rpc` handler still overrides this.
 */
function defaultRpc(name: string): { data?: any; error?: any } | null {
  if (name === 'get_cycle_roster_names') {
    const rows = [...(_data.profiles ?? []), ...(_data.guest_players ?? [])].map((r) => ({
      id: r.id,
      full_name: r.full_name ?? null,
    }));
    return { data: rows, error: null };
  }
  return null;
}

export const supabaseMock = {
  from: (table: string) => builder(table),
  rpc: (name: string, args: any) =>
    Promise.resolve(_rpc[name] ? _rpc[name](args) : (defaultRpc(name) ?? { data: null, error: null })),
};
