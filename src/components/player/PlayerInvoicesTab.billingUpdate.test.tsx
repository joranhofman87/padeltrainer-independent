import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('PlayerInvoicesTab billing update', () => {
  it('scopes invoice billing update by id and player_id', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/player/PlayerInvoicesTab.tsx'),
      'utf8'
    );
    expect(src).toContain(".eq('id', editingInvoice.id)");
    expect(src).toContain(".eq('player_id', profileId)");
  });
});
