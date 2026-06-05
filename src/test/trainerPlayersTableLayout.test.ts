import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compactDataTableClass } from '@/components/ui/data-table';

const source = readFileSync(resolve(__dirname, '../pages/TrainerPlayers.tsx'), 'utf8');

describe('TrainerPlayers table row layout', () => {
  it('uses shared compact table class and DataTableCard wrapper', () => {
    expect(source).toContain('compactDataTableClass');
    expect(source).toContain('DataTableCard');
    expect(source).toContain('testId="trainer-players-table-scroll"');
    expect(source).toMatch(/className=\{compactDataTableClass\}/);
  });

  it('uses AppPage shell instead of manual max-w-7xl wrapper', () => {
    expect(source).toContain('AppPage');
    expect(source).not.toMatch(/mx-auto w-full max-w-7xl/);
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

  it('links player names to trainer detail routes', () => {
    expect(source).toContain('to={`/app/trainer/players/${toTrainerPlayerRouteId(player)}`}');
  });

  it('does not expose row actions menu or hard delete', () => {
    expect(source).not.toContain('MoreVertical');
    expect(source).not.toContain('EditPlayerDialog');
    expect(source).not.toContain('setEditingPlayer');
    expect(source).not.toContain('setDeletingPlayer');
    expect(source).not.toContain('handleDeletePlayer');
    expect(source).not.toContain("from('guest_players').delete()");
    expect(source).not.toContain('w-[40px]');
  });

  it('links mobile cards to player detail', () => {
    expect(source).toContain('data-testid="trainer-players-mobile-cards"');
    expect(source).toContain('data-testid="trainer-player-mobile-detail-link"');
  });

  it('still renders filters and toolbar', () => {
    expect(source).toContain('TableToolbar');
    expect(source).toContain('selectedLocation');
    expect(source).toContain('selectedLevel');
    expect(source).toContain('selectedCyclus');
    expect(source).toContain('selectedTagId');
    expect(source).toContain('selectedPaymentStatus');
  });

  it('hides removed players from overview', () => {
    expect(source).toContain('removed_at');
    expect(source).toContain('shouldShowPlayerInTrainerOverview');
    expect(source).toContain('activePlayerCount');
    expect(source).toContain('filterUnifiedPlayersForActiveContext');
  });

  it('keeps DashboardEmptyState for empty list', () => {
    expect(source).toContain('DashboardEmptyState');
  });
});
