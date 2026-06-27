import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

// Table primitives every admin list page must use directly — these are NOT
// hidden behind ListPageShell, so they stay literal assertions.
const tablePrimitives = [
  'TableToolbar',
  'DataTableCard',
  'compactDataTableClass',
  'EmptyState',
] as const;

/**
 * A page provides the standard list-page chrome (AppPage + PageHeader + a
 * full-page loading skeleton) either directly, or — canonically — through
 * `ListPageShell`, which composes all three internally (see
 * src/components/ui/list-page-shell.tsx). Accepting the shell keeps this an
 * architecture guard rather than a brittle "must import AppPage" check, so a
 * page migrated onto the shell still passes while a page that drops to a
 * bespoke `container mx-auto` shell still fails.
 */
function usesListPageChrome(source: string): boolean {
  if (source.includes('ListPageShell')) return true;
  return (
    source.includes('AppPage') &&
    source.includes('PageHeader') &&
    source.includes('ListPageSkeleton')
  );
}

function expectStandardAdminListPage(source: string) {
  expect(usesListPageChrome(source)).toBe(true);
  for (const primitive of tablePrimitives) {
    expect(source).toContain(primitive);
  }
  expect(source).not.toContain('container mx-auto');
}

describe('Phase 1 admin list UI', () => {
  it('AdminUsers uses the canonical list-page chrome + table primitives', () => {
    expectStandardAdminListPage(read('pages/admin/AdminUsers.tsx'));
  });

  it('AdminTrainers uses the canonical list-page chrome + table primitives', () => {
    expectStandardAdminListPage(read('pages/admin/AdminTrainers.tsx'));
  });

  it('AdminAcademies uses the canonical list-page chrome + table primitives', () => {
    expectStandardAdminListPage(read('pages/admin/AdminAcademies.tsx'));
  });

  it('AdminGuestPlayers uses the canonical list-page chrome + table primitives + StatTile', () => {
    const source = read('pages/admin/AdminGuestPlayers.tsx');
    expectStandardAdminListPage(source);
    expect(source).toContain('StatTile');
  });
});
