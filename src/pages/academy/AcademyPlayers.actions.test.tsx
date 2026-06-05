import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AcademyPlayers actions menu', () => {
  const source = readFileSync(resolve(__dirname, 'AcademyPlayers.tsx'), 'utf8');

  it('does not wire edit player dialog from the table menu', () => {
    expect(source).not.toContain('EditPlayerDialog');
    expect(source).not.toContain('setEditingPlayer');
    expect(source).not.toContain("tTrainer('players.edit')");
    expect(source).toContain('to={`/app/academy/players/');
  });

  it('does not expose row delete menu or actions column', () => {
    expect(source).not.toContain('MoreVertical');
    expect(source).not.toContain('setDeletingPlayer');
    expect(source).not.toContain('handleDeletePlayer');
    expect(source).not.toContain("from('guest_players').delete()");
    expect(source).not.toContain('w-[40px]');
    expect(source).toContain('shouldShowPlayerInAcademyOverview');
    expect(source).toContain('removed_at');
  });
});
