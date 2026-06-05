import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, 'TrainerDashboard.tsx'), 'utf8');

describe('TrainerDashboard visibility', () => {
  it('uses active guest count excluding removed players', () => {
    expect(source).toContain('fetchActiveGuestPlayerCountForTrainer');
    expect(source).not.toMatch(/guest_players.*count: 'exact'/);
  });

  it('filters recent activity guest players by removal', () => {
    expect(source).toContain('filterGuestRowsByRemoval');
    expect(source).toContain('fetchRemovedPlayerKeys');
  });
});
