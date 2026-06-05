import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compactDataTableClass } from '@/components/ui/data-table';

const source = readFileSync(resolve(__dirname, '../pages/academy/AcademyPlayers.tsx'), 'utf8');

describe('AcademyPlayers table row layout', () => {
  it('uses shared compact table class and DataTableCard wrapper', () => {
    expect(source).toContain('compactDataTableClass');
    expect(source).toContain('DataTableCard');
    expect(source).toContain('testId="academy-players-table-scroll"');
    expect(source).toMatch(/className=\{compactDataTableClass\}/);
  });

  it('uses fixed row height via shared compact table class', () => {
    expect(compactDataTableClass).toContain('[&_tbody_tr]:h-10');
    expect(compactDataTableClass).toContain('[&_td]:max-h-10');
    expect(compactDataTableClass).toContain('min-w-[960px]');
  });

  it('prevents tag and note columns from expanding rows', () => {
    expect(source).toContain("case 'tags'");
    expect(source).toMatch(/case 'tags'[\s\S]*?overflow-hidden/);
    expect(source).toMatch(/case 'internalNotes'[\s\S]*?overflow-hidden/);
  });

  it('truncates email and location cells', () => {
    expect(source).toMatch(/case 'email'[\s\S]*?truncate/);
    expect(source).toMatch(/case 'location'[\s\S]*?truncate/);
  });

  it('uses TableToolbar for search and filters', () => {
    expect(source).toContain('TableToolbar');
    expect(source).toContain('selectedTrainerId');
    expect(source).toContain('selectedLocation');
    expect(source).toContain('selectedLevel');
    expect(source).toContain('selectedCyclus');
    expect(source).toContain('selectedTagId');
    expect(source).toContain('selectedPaymentStatus');
    expect(source).toContain('onSearchChange={setSearchQuery}');
  });

  it('uses shared EmptyState for empty list', () => {
    expect(source).toContain('EmptyState');
  });
});
