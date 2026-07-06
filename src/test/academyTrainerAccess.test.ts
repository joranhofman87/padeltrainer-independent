// Trainer-audit batch 3: academy-employed trainers must reach their PERSONAL
// settings (language/timezone + notification prefs — the new-booking emails
// footer-link straight to settings/notifications), while academy-managed pages
// stay restricted. The Sessions hub must not show them cards that bounce.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const readSrc = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('academy trainer access rules', () => {
  it('TrainerLayout restricts booking settings but NOT the settings root/notifications', () => {
    const layout = readSrc('components/trainer/TrainerLayout.tsx');
    expect(layout).toContain("'/app/trainer/settings/bookings'");
    // The old entry blocked the whole subtree via startsWith — the root must be gone.
    expect(layout).not.toMatch(/'\/app\/trainer\/settings',/);
    // Money/cycle surfaces stay restricted.
    for (const path of [
      '/app/trainer/subscription',
      '/app/trainer/earnings',
      '/app/trainer/cycles',
      '/app/trainer/schedule-overview',
    ]) {
      expect(layout).toContain(`'${path}'`);
    }
  });

  it('the academy-trainer sidebar links personal settings', () => {
    const sidebar = readSrc('components/trainer/TrainerSidebar.tsx');
    expect(sidebar).toContain('nav-academy-trainer-settings');
  });

  it('the Sessions hub hides the restricted cycle cards for academy trainers', () => {
    const hub = readSrc('pages/trainer/TrainerSessions.tsx');
    expect(hub).toContain('useTrainerHasAcademy');
    expect(hub).toMatch(/hasAcademy \? \[\] : \[\{/);
    // The two cards that used to silently bounce academy trainers to the calendar.
    expect(hub).toContain("to: '/app/trainer/cycles/bulk-copy'");
    expect(hub).toContain("to: '/app/trainer/cycles/new'");
  });
});
