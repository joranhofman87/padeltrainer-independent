import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

/**
 * Cursor-list behaviour shared by every N4 admin operational section — and by N5/N6/N7's
 * surfaces, which read the same composite-keyset RPC family (backlog/boundary lists, postflight
 * feeds). It is extracted because it is used SIX times already, not speculatively.
 *
 * What it owns, and why each piece exists (each was a review finding):
 *  * the cursor is the LAST ROW's RAW string fields, passed back verbatim — a Date round-trip
 *    destroys the microseconds these RPCs order on;
 *  * a SYNCHRONOUS ref lock — `if (busy)` reads pre-commit render state and lets two clicks
 *    through;
 *  * a request EPOCH — a superseded response must never overwrite newer state;
 *  * functional state updates — appends must not read a stale closure.
 *
 * It deliberately does NOT model filters, sorting, or the page chrome: those differ per section
 * and belong in the section component.
 */
export interface CursorList<T> {
  rows: T[] | null;
  error: boolean;
  busy: boolean;
  /** true once a page returned fewer rows than requested — nothing more to fetch. */
  exhausted: boolean;
  load: (more?: boolean) => Promise<void>;
  reset: () => void;
}

export function useCursorList<T extends Record<string, unknown>>(
  rpcName: string,
  cursorFields: readonly [string, string],
  cursorParams: readonly [string, string],
  extraArgs: () => Record<string, unknown> = () => ({}),
  pageSize = 25,
): CursorList<T> {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const epoch = useRef(0);
  const lock = useRef(false);

  const load = async (more = false) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    const myEpoch = ++epoch.current;
    const last = more && rows?.length ? rows[rows.length - 1] : null;
    const args: Record<string, unknown> = { ...extraArgs(), p_limit: pageSize };
    if (last) {
      args[cursorParams[0]] = last[cursorFields[0]] as string;
      args[cursorParams[1]] = last[cursorFields[1]] as string;
    }
    const { data, error: err } = await supabase.rpc(rpcName as never, args as never);
    if (myEpoch !== epoch.current) return;   // superseded: drop it, keep the newer owner's lock
    lock.current = false;
    if (err) { setError(true); setBusy(false); return; }
    const page = (data ?? []) as T[];
    setExhausted(page.length < pageSize);
    setRows((prev) => (more && prev ? [...prev, ...page] : page));
    setBusy(false);
  };

  const reset = () => {
    epoch.current++;
    lock.current = false;
    setRows(null);
    setError(false);
    setExhausted(false);
    setBusy(false);
  };

  return { rows, error, busy, exhausted, load, reset };
}
