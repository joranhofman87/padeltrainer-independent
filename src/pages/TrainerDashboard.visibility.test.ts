import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, 'TrainerDashboard.tsx'), 'utf8');

describe('TrainerDashboard visibility', () => {
  it('derives total students from the shared players-overview RPC (matches the Players page; removal applied server-side)', () => {
    expect(source).toContain('fetchPlayersOverview');
    // No bespoke guest-only count — the dashboard total must equal the Players
    // page total (guests + registered), with removal handled inside the RPC.
    expect(source).not.toContain('fetchActiveGuestPlayerCountForTrainer');
    expect(source).not.toMatch(/guest_players.*count: 'exact'/);
  });

  it('uses AppPage shell', () => {
    expect(source).toContain('AppPage');
    expect(source).toContain('TrainerPageHeader');
  });

  it('filters recent activity guest players by removal', () => {
    expect(source).toContain('filterGuestRowsByRemoval');
    expect(source).toContain('fetchRemovedPlayerKeys');
  });
});
