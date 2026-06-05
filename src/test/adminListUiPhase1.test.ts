import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

const sharedPrimitives = [
  'AppPage',
  'PageHeader',
  'TableToolbar',
  'DataTableCard',
  'compactDataTableClass',
  'EmptyState',
  'ListPageSkeleton',
] as const;

describe('Phase 1 admin list UI', () => {
  it('AdminUsers uses shared list primitives', () => {
    const source = read('pages/admin/AdminUsers.tsx');
    for (const primitive of sharedPrimitives) {
      expect(source).toContain(primitive);
    }
    expect(source).not.toContain('container mx-auto');
  });

  it('AdminTrainers uses shared list primitives', () => {
    const source = read('pages/admin/AdminTrainers.tsx');
    for (const primitive of sharedPrimitives) {
      expect(source).toContain(primitive);
    }
    expect(source).not.toContain('container mx-auto');
  });

  it('AdminAcademies uses shared list primitives', () => {
    const source = read('pages/admin/AdminAcademies.tsx');
    for (const primitive of sharedPrimitives) {
      expect(source).toContain(primitive);
    }
    expect(source).not.toContain('container mx-auto');
  });

  it('AdminGuestPlayers uses shared list primitives and StatTile', () => {
    const source = read('pages/admin/AdminGuestPlayers.tsx');
    for (const primitive of sharedPrimitives) {
      expect(source).toContain(primitive);
    }
    expect(source).toContain('StatTile');
    expect(source).not.toContain('container mx-auto');
  });
});
