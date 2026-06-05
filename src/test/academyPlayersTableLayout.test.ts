import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../pages/academy/AcademyPlayers.tsx'), 'utf8');

describe('AcademyPlayers table row layout', () => {
  it('uses fixed row height and horizontal scroll on desktop table', () => {
    expect(source).toContain('data-testid="academy-players-table-scroll"');
    expect(source).toContain('overflow-x-auto');
    expect(source).toContain('[&_tbody_tr]:h-10');
    expect(source).toContain('[&_td]:max-h-10');
  });

  it('prevents tag and note columns from expanding rows', () => {
    expect(source).toContain('case \'tags\'');
    expect(source).toMatch(/case 'tags'[\s\S]*?overflow-hidden/);
    expect(source).toMatch(/case 'internalNotes'[\s\S]*?overflow-hidden/);
  });

  it('truncates email and location cells', () => {
    expect(source).toMatch(/case 'email'[\s\S]*?truncate/);
    expect(source).toMatch(/case 'location'[\s\S]*?truncate/);
  });
});
