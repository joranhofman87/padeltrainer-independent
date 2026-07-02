/**
 * A minimal supabase-js–shaped adapter backed by a real PGlite (in-WASM Postgres) instance, so
 * vitest can run the ACTUAL app lib (invoiceSync, bookings, …) against real SQL — not a JS mock.
 *
 * It supports ONLY the query surface those money-path functions use (verified by grepping their
 * `.from/.select/.eq/.in/.overlaps/.order/.range/.maybeSingle/.update/.rpc` calls): no `.delete/
 * .contains/.single` beyond what is implemented here. `.range()` maps to LIMIT/OFFSET and an
 * opt-in `maxRows` models PostgREST's per-response cap. The one embedded-resource select (bookings → availability_slots →
 * locations) is special-cased to the exact shape the recalc expects. Keep this adapter narrow: add
 * an operator only when a function under test needs it, so it never silently diverges from real
 * PostgREST on a shape we don't exercise.
 */
import type { PGlite } from '@electric-sql/pglite';

type FilterKind = 'eq' | 'neq' | 'in' | 'overlaps' | 'gte';
interface Filter { kind: FilterKind; col: string; val: unknown; }
interface SupaResult<T> { data: T; error: { message: string; code?: string } | null; }

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
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private columns = '*';
  private updateData: Record<string, unknown> | null = null;
  private insertRows: Record<string, unknown>[] | null = null;
  private filters: Filter[] = [];
  private singleRow = false;
  private orderBy: { col: string; ascending: boolean } | null = null;
  private rangeWindow: { from: number; to: number } | null = null;

  constructor(
    private db: PGlite,
    private table: string,
    // Opt-in: model PostgREST's fixed per-response row cap. When set, a plain
    // (non-single) SELECT with NO explicit .range() is truncated to this many
    // rows — reproducing the silent server truncation that a paged reader must
    // walk around. UPDATE…RETURNING and .single()/.maybeSingle() are untouched.
    private maxRows: number | null = null,
  ) {}

  select(columns = '*') { this.columns = columns; return this; }
  update(data: Record<string, unknown>) { this.op = 'update'; this.updateData = data; return this; }
  insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
    this.op = 'insert';
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.filters.push({ kind: 'eq', col, val }); return this; }
  neq(col: string, val: unknown) { this.filters.push({ kind: 'neq', col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ kind: 'gte', col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ kind: 'in', col, val }); return this; }
  overlaps(col: string, val: unknown[]) { this.filters.push({ kind: 'overlaps', col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, ascending: opts?.ascending !== false }; return this; }
  // PostgREST .range(from,to) is inclusive on both ends → LIMIT/OFFSET. Returns
  // the (thenable) builder, matching supabase-js, so callers can `await` it.
  range(from: number, to: number) { this.rangeWindow = { from, to }; return this; }
  maybeSingle() { this.singleRow = true; return this.run(); }
  single() { this.singleRow = true; return this.run(); }

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
      if (f.kind === 'gte') return `${f.col} >= ${p}`;
      if (f.kind === 'in') return `${f.col} = ANY(${p})`;
      return `${f.col} && ${p}`; // overlaps
    });
    return ` WHERE ${parts.join(' AND ')}`;
  }

  // ORDER BY + inclusive-range LIMIT/OFFSET. `tablePrefix` qualifies the order
  // column in the embedded-select branch (aliased table `b`).
  private orderRangeClause(tablePrefix: string): string {
    let clause = '';
    if (this.orderBy) {
      const col = this.orderBy.col.includes('.') ? this.orderBy.col : `${tablePrefix}${this.orderBy.col}`;
      clause += ` ORDER BY ${col} ${this.orderBy.ascending ? 'ASC' : 'DESC'}`;
    }
    if (this.rangeWindow) {
      const { from, to } = this.rangeWindow;
      const limit = Math.max(0, to - from + 1);
      clause += ` LIMIT ${limit} OFFSET ${from}`;
    } else if (this.maxRows != null && !this.singleRow) {
      // No explicit range → apply the modelled PostgREST cap (silent truncation).
      clause += ` LIMIT ${this.maxRows}`;
    }
    return clause;
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
      } else if (this.op === 'insert') {
        const rows = this.insertRows ?? [];
        if (rows.length === 0) return { data: this.singleRow ? null : [], error: null };
        // Homogeneous rows (the generator builds identical column sets) → columns from row[0].
        const cols = Object.keys(rows[0]);
        const tuples = rows.map((row) => {
          const placeholders = cols.map((col) => {
            const val = row[col];
            if (isJsonb(val)) { params.push(JSON.stringify(val)); return `$${params.length}::jsonb`; }
            params.push(val); return `$${params.length}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        const returning = this.columns && this.columns !== '*' ? this.columns : '*';
        sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES ${tuples.join(', ')} RETURNING ${returning}`;
      } else if (this.op === 'delete') {
        sql = `DELETE FROM ${this.table}${this.whereClause(params)}`;
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
          this.whereClause(params).replace(/ (\w+) = ANY/g, ' b.$1 = ANY').replace(/ (\w+) = \$/g, ' b.$1 = $') +
          this.orderRangeClause('b.');
      } else {
        sql = `SELECT ${this.columns} FROM ${this.table}${this.whereClause(params)}${this.orderRangeClause('')}`;
      }
      const res = await this.db.query(sql, params);
      const rows = res.rows as unknown[];
      return { data: this.singleRow ? (rows[0] ?? null) : rows, error: null };
    } catch (e) {
      // Surface the Postgres error `code` (e.g. '23505' unique_violation) so
      // helpers that branch on error.code (applyBookingPaymentWriteback M-17
      // tolerance) behave against PGlite as they do against PostgREST.
      const err = e as { message?: string; code?: string };
      return { data: this.singleRow ? null : [], error: { message: err.message ?? String(e), code: err.code } };
    }
  }
}

export interface PgliteSupabase {
  from(table: string): QueryBuilder;
  rpc(name: string, args: Record<string, unknown>): Promise<SupaResult<unknown>>;
  functions: { invoke(name: string, opts?: unknown): Promise<SupaResult<unknown>> };
}

/**
 * Wrap a PGlite instance in the supabase-js–shaped surface the money-path lib uses.
 *
 * `opts.maxRows` opt-in models PostgREST's fixed per-response row cap so tests
 * can prove a paged reader assembles a set larger than one page (and that an
 * un-paged read would silently truncate). Omit it for the default behaviour.
 */
export function createPgliteSupabase(
  db: PGlite,
  opts?: { maxRows?: number },
): PgliteSupabase {
  const maxRows = opts?.maxRows ?? null;
  return {
    from: (table: string) => new QueryBuilder(db, table, maxRows),
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
