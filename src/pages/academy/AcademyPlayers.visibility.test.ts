import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldShowPlayerInAcademyOverview } from '@/lib/academyPlayerRemoval';

const source = readFileSync(resolve(__dirname, 'AcademyPlayers.tsx'), 'utf8');
const rpcMigration = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/20260611160001_get_players_overview.sql'),
  'utf8',
);

describe('AcademyPlayers visibility', () => {
  it('consumes the players-overview RPC, which enforces removal in SQL', () => {
    expect(source).toContain('usePlayersOverview');
    expect(rpcMigration).toContain('removed_at IS NOT NULL');
    expect(rpcMigration).toContain('NOT EXISTS (SELECT 1 FROM removed_meta rm WHERE rm.gid = g.id)');
    expect(rpcMigration).toContain('NOT EXISTS (SELECT 1 FROM removed_meta rm WHERE rm.pid = r.pid)');
  });

  it('uses active player count excluding removed players', () => {
    expect(source).toContain('activePlayerCount');
    expect(source).not.toMatch(/count=\{players\.length\}/);
  });

  it('email campaign recipients come from the complete server-filtered list', () => {
    expect(source).toContain('fetchAllPlayersOverview');
    expect(source).toContain('campaignAll');
  });

  it('renders through the shared DataTable engine', () => {
    expect(source).toContain('TableToolbar');
    expect(source).toContain('<DataTable');
    expect(source).toContain("from '@/components/ui/data-table-generic'");
    expect(source).toContain('EmptyState');
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
