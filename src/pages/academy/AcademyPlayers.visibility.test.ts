import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldShowPlayerInAcademyOverview } from '@/lib/academyPlayerRemoval';

const source = readFileSync(resolve(__dirname, 'AcademyPlayers.tsx'), 'utf8');

describe('AcademyPlayers visibility', () => {
  it('filters overview with shouldShowPlayerInAcademyOverview', () => {
    expect(source).toContain('shouldShowPlayerInAcademyOverview');
    expect(source).toContain('removed_at');
  });

  it('uses active player count excluding removed players', () => {
    expect(source).toContain('activePlayerCount');
    expect(source).not.toMatch(/count=\{players\.length\}/);
  });

  it('excludes removed players from email campaign recipients', () => {
    expect(source).toContain('filterUnifiedPlayersForActiveContext');
    expect(source).toContain("filterUnifiedPlayersForActiveContext(players, metadata, 'academy')");
  });

  it('does not hard-delete players from overview', () => {
    expect(source).not.toContain("from('guest_players').delete()");
  });
});

describe('shouldShowPlayerInAcademyOverview', () => {
  it('hides removed players', () => {
    expect(shouldShowPlayerInAcademyOverview({ removed_at: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(shouldShowPlayerInAcademyOverview({ removed_at: null })).toBe(true);
    expect(shouldShowPlayerInAcademyOverview(undefined)).toBe(true);
  });
});
