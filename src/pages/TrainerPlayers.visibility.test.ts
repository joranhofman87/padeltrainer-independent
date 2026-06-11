import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldShowPlayerInTrainerOverview } from '@/lib/trainerPlayerRemoval';

const source = readFileSync(resolve(__dirname, 'TrainerPlayers.tsx'), 'utf8');
const rpcMigration = readFileSync(
  resolve(__dirname, '../../supabase/migrations/20260611160001_get_players_overview.sql'),
  'utf8',
);

describe('TrainerPlayers visibility', () => {
  it('consumes the players-overview RPC, which enforces removal in SQL', () => {
    expect(source).toContain('usePlayersOverview');
    expect(source).toContain("kind: 'trainer'");
    expect(rpcMigration).toContain('removed_at IS NOT NULL');
    expect(rpcMigration).toContain('NOT EXISTS (SELECT 1 FROM removed_meta rm WHERE rm.gid = g.id)');
    expect(rpcMigration).toContain('NOT EXISTS (SELECT 1 FROM removed_meta rm WHERE rm.pid = r.pid)');
  });

  it('uses active player count excluding removed players', () => {
    expect(source).toContain('activePlayerCount');
    expect(source).not.toMatch(/countText=\{`\$\{players\.length\}/);
  });

  it('email campaign recipients come from the complete server-filtered list', () => {
    expect(source).toContain('fetchAllPlayersOverview');
    expect(source).toContain('campaignAll');
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
