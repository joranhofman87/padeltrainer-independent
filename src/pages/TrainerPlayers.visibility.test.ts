import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldShowPlayerInTrainerOverview } from '@/lib/trainerPlayerRemoval';

const source = readFileSync(resolve(__dirname, 'TrainerPlayers.tsx'), 'utf8');

describe('TrainerPlayers visibility', () => {
  it('filters overview with shouldShowPlayerInTrainerOverview', () => {
    expect(source).toContain('shouldShowPlayerInTrainerOverview');
    expect(source).toContain('removed_at');
  });

  it('uses active player count excluding removed players', () => {
    expect(source).toContain('activePlayerCount');
    expect(source).not.toMatch(/countText=\{`\$\{players\.length\}/);
  });

  it('does not hard-delete players from overview', () => {
    expect(source).not.toContain("from('guest_players').delete()");
    expect(source).not.toContain('handleDeletePlayer');
    expect(source).not.toContain('MoreVertical');
  });
});

describe('shouldShowPlayerInTrainerOverview', () => {
  it('hides removed players', () => {
    expect(shouldShowPlayerInTrainerOverview({ removed_at: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(shouldShowPlayerInTrainerOverview({ removed_at: null })).toBe(true);
    expect(shouldShowPlayerInTrainerOverview(undefined)).toBe(true);
  });
});
