import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../pages/club/ClubPlayers.tsx'), 'utf8');

// Built dynamically so a repo-wide grep for the deleted hook stays clean.
const deletedHookName = ['use', 'Player', 'Sort'].join('');

describe('ClubPlayers shared list stack', () => {
  it('composes the shared academy list-stack components', () => {
    expect(source).toContain("from '@/components/ui/list-page-shell'");
    expect(source).toContain('<ListPageShell');
    expect(source).toContain('<ListPageState');
    expect(source).toContain("from '@/components/ui/table-toolbar'");
    expect(source).toContain('<TableToolbar');
    // The table itself is the canonical DataTable engine (which renders SortableTableHead
    // internally); sorting is wired to it via sortKey/onSort — see the useTableSort test below.
    expect(source).toContain("from '@/components/ui/data-table-generic'");
    expect(source).toContain('<DataTable');
    expect(source).toContain("from '@/components/ui/list-pagination'");
    expect(source).toContain('<ListPagination');
    expect(source).toContain("from '@/components/ui/empty-state'");
    expect(source).toContain('<EmptyState');
  });

  it('sorts via the shared useTableSort hook with emptyLast (old club semantics: empties last both ways)', () => {
    expect(source).toContain("from '@/hooks/useTableSort'");
    expect(source).toContain('useTableSort(');
    expect(source).toContain('emptyLast: true');
  });

  it('no longer references the deleted duplicate sort hook', () => {
    expect(source).not.toContain(deletedHookName);
    expect(existsSync(resolve(__dirname, `../components/players/${deletedHookName}.tsx`))).toBe(false);
  });

  it('filters by search before sorting and resets the page on search change', () => {
    expect(source).toContain('filteredPlayers');
    expect(source).toMatch(/useTableSort\(\s*filteredPlayers/);
    expect(source).toContain('onSearchChange={handleSearchChange}');
    expect(source).toMatch(/setSearch\(value\);\s*\n\s*setPage\(0\);/);
  });

  it('has the new club i18n keys in both languages', () => {
    for (const lang of ['en', 'nl'] as const) {
      const bundle = JSON.parse(
        readFileSync(resolve(__dirname, `../i18n/locales/${lang}/club.json`), 'utf8'),
      );
      expect(bundle.players.searchPlaceholder, `${lang} searchPlaceholder`).toBeTruthy();
      expect(bundle.players.noResults, `${lang} noResults`).toBeTruthy();
      expect(bundle.players.countOne, `${lang} countOne`).toBeTruthy();
      expect(bundle.players.countOther, `${lang} countOther`).toBeTruthy();
    }
  });
});
