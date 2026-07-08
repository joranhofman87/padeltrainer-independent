import { join } from 'node:path';

/** Shared auth helpers for local E2E (plain module — not a test file, so specs may import it). */
export const authFile = (role: string) => join('e2e', 'local', '.auth', `${role}.json`);

export const PASSWORD = 'Password123!';

/** Seeded logins (scripts/db/seed-local.ts). */
export const LOGINS: Record<string, string> = {
  manager: 'academy.manager@local.test',
  trainer: 'trainer1.a0@local.test',
  player: 'player1.a0@local.test',
};
