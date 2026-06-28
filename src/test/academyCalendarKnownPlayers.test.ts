import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '..', 'pages/academy/AcademyCalendar.tsx'), 'utf8');

/**
 * Regression guard for the AcademyCalendar known-players sidebar scale bug
 * (Codex foundation-verification, Tier C1).
 *
 * The book-for-player sidebar was built from two UNBOUNDED scans — every slot the
 * academy's trainers ever had, then every booking on those slots — each capped at
 * PostgREST's 1000 rows. Past ~1000 lifetime bookings the list SILENTLY truncated,
 * dropping registered players from the picker. It now comes from the canonical,
 * server-paginated players-overview RPC (the same membership the AcademyPlayers
 * table renders), so it can never truncate.
 */
describe('AcademyCalendar known-players sidebar — bounded via the players-overview RPC', () => {
  it('builds the sidebar from fetchAllPlayersOverview (server-paginated), not raw scans', () => {
    expect(source).toMatch(/fetchAllPlayersOverview\(\s*\{\s*kind:\s*['"]academy['"]/);
  });

  it('no longer runs the unbounded all-bookings player_id scan that truncated at 1000 rows', () => {
    expect(source).not.toMatch(/from\(\s*['"]bookings['"]\s*\)\s*\.select\(\s*['"]player_id['"]\s*\)/);
  });

  it('no longer scans every academy slot id just to discover players', () => {
    expect(source).not.toMatch(/from\(\s*['"]availability_slots['"]\s*\)\s*\.select\(\s*['"]id['"]\s*\)/);
  });
});
