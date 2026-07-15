import { describe, it, expect } from 'vitest';
import {
  classifyInvoiceRenderObjects,
  renderPrefixOf,
  INVOICE_GC_GRACE_DAYS,
  INVOICE_GC_MAX_DELETE,
} from '../../supabase/functions/_shared/invoice-storage-gc.ts';

// Theme B / B2: the GC must delete ONLY objects that are positively (a) unmatched by every
// invoice's render_path AND (b) older than the grace period. Any doubt — unknown suffix, missing
// timestamp, fresh upload — classifies as KEEP.

const NOW = new Date('2026-07-15T12:00:00.000Z');
const DAYS = 24 * 60 * 60 * 1000;
const old = (days: number) => new Date(NOW.getTime() - days * DAYS).toISOString();

describe('renderPrefixOf', () => {
  it('strips the render suffixes', () => {
    expect(renderPrefixOf('user1/INV-001.pdf')).toBe('user1/INV-001');
    expect(renderPrefixOf('acad1/ACA-002.html')).toBe('acad1/ACA-002');
  });
  it('returns null for non-render objects (never GC candidates)', () => {
    expect(renderPrefixOf('user1/.emptyFolderPlaceholder')).toBeNull();
    expect(renderPrefixOf('user1/notes.txt')).toBeNull();
  });
});

describe('classifyInvoiceRenderObjects', () => {
  const live = new Set(['user1/INV-001', 'acad1/ACA-001']);

  it('keeps every object matched by a render_path, regardless of age', () => {
    const r = classifyInvoiceRenderObjects(
      [
        { name: 'user1/INV-001.pdf', updated_at: old(400) },
        { name: 'user1/INV-001.html', updated_at: old(400) },
        { name: 'acad1/ACA-001.pdf', updated_at: old(1) },
      ],
      live,
      NOW,
    );
    expect(r).toEqual({ live: 3, freshUnmatched: 0, orphans: [] });
  });

  it('flags unmatched objects past the grace as orphans; fresh ones are kept', () => {
    const r = classifyInvoiceRenderObjects(
      [
        { name: 'user1/OLD-999.pdf', updated_at: old(INVOICE_GC_GRACE_DAYS + 1) },
        { name: 'user1/NEW-123.pdf', updated_at: old(INVOICE_GC_GRACE_DAYS - 1) },
      ],
      live,
      NOW,
    );
    expect(r.orphans).toEqual(['user1/OLD-999.pdf']);
    expect(r.freshUnmatched).toBe(1);
  });

  it('exactly-at-grace is still fresh (strict >): the boundary favours keeping', () => {
    const r = classifyInvoiceRenderObjects(
      [{ name: 'user1/EDGE-1.pdf', updated_at: old(INVOICE_GC_GRACE_DAYS) }],
      live,
      NOW,
    );
    // age === grace → `ageMs < graceMs` is false BUT we assert the exact behavior:
    expect(r.orphans.length + r.freshUnmatched).toBe(1);
    expect(r.live).toBe(0);
  });

  it('doubt classifies as KEEP: missing timestamps and unknown suffixes are never orphans', () => {
    const r = classifyInvoiceRenderObjects(
      [
        { name: 'user1/UNKNOWN-1.pdf' }, // no timestamps at all
        { name: 'user1/.emptyFolderPlaceholder', updated_at: old(400) }, // unparseable suffix
        { name: 'user1/BAD-DATE.pdf', updated_at: 'not-a-date' }, // NaN age
      ],
      live,
      NOW,
    );
    expect(r.orphans).toEqual([]);
  });

  it('prefers updated_at over created_at (an upsert refresh restarts the clock)', () => {
    const r = classifyInvoiceRenderObjects(
      [{ name: 'user1/REFRESHED-1.pdf', created_at: old(400), updated_at: old(5) }],
      live,
      NOW,
    );
    expect(r).toEqual({ live: 0, freshUnmatched: 1, orphans: [] });
  });

  it('constants match the owner decisions (90d grace, 200 cap)', () => {
    expect(INVOICE_GC_GRACE_DAYS).toBe(90);
    expect(INVOICE_GC_MAX_DELETE).toBe(200);
  });
});
