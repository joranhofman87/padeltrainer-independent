import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AcademyPlayers actions menu', () => {
  it('does not wire edit player dialog from the table menu', () => {
    const source = readFileSync(resolve(__dirname, 'AcademyPlayers.tsx'), 'utf8');

    expect(source).not.toContain('EditPlayerDialog');
    expect(source).not.toContain('setEditingPlayer');
    expect(source).not.toContain("tTrainer('players.edit')");
    expect(source).toContain('to={`/app/academy/players/');
  });
});
