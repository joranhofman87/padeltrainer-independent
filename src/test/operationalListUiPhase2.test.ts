import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

describe('Phase 2 operational list UI', () => {
  it('AcademyTrainers renders the active table through the shared DataTable engine', () => {
    const source = read('pages/academy/AcademyTrainers.tsx');
    expect(source).toContain("from '@/components/ui/data-table-generic'");
    expect(source).toContain('<DataTable');
    expect(source).toContain('cardTestId="academy-trainers-table-scroll"');
    expect(source).toContain('EmptyState');
    // Page chrome + loading skeleton + empty/content switching still come via the
    // shared list-page shell (which renders ListPageSkeleton internally).
    expect(source).toContain('ListPageShell');
    expect(source).toContain('ListPageState');
  });

  it('AcademyWaitingList uses AppPage and PageHeader', () => {
    const source = read('pages/academy/AcademyWaitingList.tsx');
    expect(source).toContain('AppPage');
    expect(source).toContain('PageHeader');
    expect(source).toContain('ListPageSkeleton');
    expect(source).not.toContain('container mx-auto');
  });

  it('TrainerWaitingList uses AppPage and TrainerPageHeader', () => {
    const source = read('pages/TrainerWaitingList.tsx');
    expect(source).toContain('AppPage');
    expect(source).toContain('TrainerPageHeader');
    expect(source).toContain('ListPageSkeleton');
    expect(source).not.toContain('container mx-auto');
  });

  it('WaitingListTable uses shared table primitives', () => {
    const source = read('components/waitingList/WaitingListTable.tsx');
    expect(source).toContain('DataTableCard');
    expect(source).toContain('compactDataTableClass');
    expect(source).toContain('TableToolbar');
    expect(source).toContain('EmptyState');
  });

  it('AcademyDashboard uses StatTile and dashboard skeleton', () => {
    const source = read('pages/academy/AcademyDashboard.tsx');
    expect(source).toContain('StatTile');
    expect(source).toContain('DashboardPageSkeleton');
    expect(source).toContain('DashboardSectionHeader');
    expect(source).toContain('compactDataTableClass');
  });

  it('TrainerDashboard uses AppPage and TrainerPageHeader', () => {
    const source = read('pages/TrainerDashboard.tsx');
    expect(source).toContain('AppPage');
    expect(source).toContain('TrainerPageHeader');
    expect(source).toContain('DashboardPageSkeleton');
    expect(source).not.toMatch(/mx-auto w-full max-w-7xl/);
  });
});
