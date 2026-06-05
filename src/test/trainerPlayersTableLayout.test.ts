import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../pages/TrainerPlayers.tsx'), 'utf8');

describe('TrainerPlayers table row layout', () => {
  it('uses fixed row height and horizontal scroll on desktop table', () => {
    expect(source).toContain('data-testid="trainer-players-table-scroll"');
    expect(source).toContain('overflow-x-auto');
    expect(source).toContain('min-w-[960px]');
    expect(source).toContain('[&_tbody_tr]:h-10');
    expect(source).toContain('[&_td]:max-h-10');
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
});
