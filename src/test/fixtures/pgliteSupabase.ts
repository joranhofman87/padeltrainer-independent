/**
 * A minimal supabase-js–shaped adapter backed by a real PGlite (in-WASM Postgres) instance, so
 * vitest can run the ACTUAL app lib (invoiceSync, bookings, …) against real SQL — not a JS mock.
 *
 * It supports ONLY the query surface those money-path functions use (verified by grepping their
 * `.from/.select/.eq/.in/.overlaps/.maybeSingle/.update/.rpc` calls): no `.order/.range/.delete/
 * .contains/.single`. The one PostgREST embedded-resource select (bookings → availability_slots →
 * locations) is special-cased to the exact shape the recalc expects. Keep this adapter narrow: add
 * an operator only when a function under test needs it, so it never silently diverges from real
 * PostgREST on a shape we don't exercise.
 */
import type { PGlite } from '@electric-sql/pglite';

type FilterKind = 'eq' | 'neq' | 'in' | 'overlaps';
interface Filter { kind: FilterKind; col: string; val: unknown; }
interface SupaResult<T> { data: T; error: { message: string } | null; }

const isPrimitive = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
// jsonb columns (line_items, vat_breakdown, settings) carry objects / arrays-of-objects; text[]
// columns (booking_ids) carry arrays of primitives. Distinguish so SET binds the right type.
const isJsonb = (v: unknown) =>
  v !== null && typeof v === 'object' && !(v instanceof Date) &&
  !(Array.isArray(v) && v.every(isPrimitive));

// The exact embedded select invoiceSync uses; matched by substring so we render the nested object
// `availability_slots: { …, locations: { name } }` the recalc reads.
const EMBED_MARK = 'availability_slots!inner';

class QueryBuilder implements PromiseLike<SupaResult<unknown>> {
  private op: 'select' | 'update' = 'select';
  private columns = '*';
  private updateData: Record<string, unknown> | null = null;
  private filters: Filter[] = [];
  private singleRow = false;

  constructor(private db: PGlite, private table: string) {}

  select(columns = '*') { this.columns = columns; return this; }
  update(data: Record<string, unknown>) { this.op = 'update'; this.updateData = data; return this; }
  eq(col: string, val: unknown) { this.filters.push({ kind: 'eq', col, val }); return this; }
  neq(col: string, val: unknown) { this.filters.push({ kind: 'neq', col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ kind: 'in', col, val }); return this; }
  overlaps(col: string, val: unknown[]) { this.filters.push({ kind: 'overlaps', col, val }); return this; }
  maybeSingle() { this.singleRow = true; return this.run(); }

  // Thenable: `await builder` runs the query.
  then<R1 = SupaResult<unknown>, R2 = never>(
    onFulfilled?: ((v: SupaResult<unknown>) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onFulfilled, onRejected);
  }

  private whereClause(params: unknown[]): string {
    if (this.filters.length === 0) return '';
    const parts = this.filters.map((f) => {
      params.push(f.kind === 'overlaps' || f.kind === 'in' ? f.val : f.val);
      const p = `$${params.length}`;
      if (f.kind === 'eq') return `${f.col} = ${p}`;
      // `<>` matches PostgREST .neq(): NULL-unsafe, so a NULL column does NOT pass the filter.
      if (f.kind === 'neq') return `${f.col} <> ${p}`;
      if (f.kind === 'in') return `${f.col} = ANY(${p})`;
      return `${f.col} && ${p}`; // overlaps
    });
    return ` WHERE ${parts.join(' AND ')}`;
  }

  private async run(): Promise<SupaResult<unknown>> {
    const params: unknown[] = [];
    try {
      let sql: string;
      if (this.op === 'update') {
        const sets = Object.entries(this.updateData ?? {}).map(([col, val]) => {
          if (isJsonb(val)) { params.push(JSON.stringify(val)); return `${col} = $${params.length}::jsonb`; }
          params.push(val); return `${col} = $${params.length}`;
        });
        const returning = this.columns && this.columns !== '*' ? this.columns : '*';
        sql = `UPDATE ${this.table} SET ${sets.join(', ')}${this.whereClause(params)} RETURNING ${returning}`;
      } else if (this.columns.includes(EMBED_MARK)) {
        // bookings + the embedded slot (+ its location) the recalc reads.
        sql =
          `SELECT b.id, b.payment_amount, json_build_object(` +
          `'price_per_session', s.price_per_session, 'cyclus_id', s.cyclus_id, ` +
          `'cyclus_name', s.cyclus_name, 'start_time', s.start_time, ` +
          `'prices_include_vat', s.prices_include_vat, 'extra_costs', s.extra_costs, ` +
          `'locations', CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object('name', l.name) END` +
          `) AS availability_slots ` +
          `FROM ${this.table} b JOIN availability_slots s ON s.id = b.slot_id ` +
          `LEFT JOIN locations l ON l.id = s.location_id` +
          this.whereClause(params).replace(/ (\w+) = ANY/g, ' b.$1 = ANY').replace(/ (\w+) = \$/g, ' b.$1 = $');
      } else {
        sql = `SELECT ${this.columns} FROM ${this.table}${this.whereClause(params)}`;
      }
      const res = await this.db.query(sql, params);
      const rows = res.rows as unknown[];
      return { data: this.singleRow ? (rows[0] ?? null) : rows, error: null };
    } catch (e) {
      return { data: this.singleRow ? null : [], error: { message: (e as Error).message } };
    }
  }
}

export interface PgliteSupabase {
  from(table: string): QueryBuilder;
  rpc(name: string, args: Record<string, unknown>): Promise<SupaResult<unknown>>;
  functions: { invoke(name: string, opts?: unknown): Promise<SupaResult<unknown>> };
}

/** Wrap a PGlite instance in the supabase-js–shaped surface the money-path lib uses. */
export function createPgliteSupabase(db: PGlite): PgliteSupabase {
  return {
    from: (table: string) => new QueryBuilder(db, table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        const keys = Object.keys(args);
        const sql = `SELECT * FROM ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
        const res = await db.query(sql, keys.map((k) => args[k]));
        const rows = res.rows as unknown[];
        // RPCs that RETURN a scalar come back as a single row { name: value }; surface that value.
        const first = rows[0] as Record<string, unknown> | undefined;
        const scalar = first && Object.keys(first).length === 1 ? Object.values(first)[0] : rows;
        return { data: scalar ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    functions: { invoke: async () => ({ data: null, error: null }) }, // PDF regen etc. — no-op in tests
  };
}
