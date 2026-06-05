import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

const AUTHENTICATED_SIDEBARS = [
  'components/academy/AcademySidebar.tsx',
  'components/player/PlayerSidebar.tsx',
  'components/trainer/TrainerSidebar.tsx',
  'components/club/ClubSidebar.tsx',
  'components/admin/AdminSidebar.tsx',
] as const;

const AUTHENTICATED_LAYOUTS = [
  'components/academy/AcademyLayout.tsx',
  'components/player/PlayerLayout.tsx',
  'components/trainer/TrainerLayout.tsx',
  'components/club/ClubLayout.tsx',
  'components/admin/AdminLayout.tsx',
] as const;

function readSrc(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('authenticated sidebar migration', () => {
  it.each(AUTHENTICATED_SIDEBARS)('%s uses shared app sidebar shell styles', (file) => {
    const source = readSrc(file);
    expect(source).toContain('appSidebarShellClass');
    expect(source).toContain('appNavLinkActive');
    expect(source).not.toContain('bg-sidebar-accent');
    expect(source).not.toContain('text-sidebar-accent-foreground');
  });

  it('TrainerSidebar uses /app/trainer routes (not legacy /trainer)', () => {
    const source = readSrc('components/trainer/TrainerSidebar.tsx');
    expect(source).toContain('"/app/trainer');
    expect(source).not.toMatch(/to="\/trainer\//);
    expect(source).not.toMatch(/isActive\("\/trainer\//);
  });

  it.each(AUTHENTICATED_SIDEBARS)('%s closes mobile drawer on nav interaction', (file) => {
    const source = readSrc(file);
    expect(source).toContain('closeMobileDrawer');
    expect(source).toContain('setOpenMobile(false)');
  });

  it.each(AUTHENTICATED_LAYOUTS)('%s uses Academy-style mobile menu trigger', (file) => {
    const source = readSrc(file);
    expect(source).toContain('mobile-menu-trigger');
    expect(source).not.toContain('SidebarTrigger');
  });
});

describe('role-specific navigation preserved', () => {
  it('TrainerSidebar keeps schedule, players, and business nav', () => {
    const source = readSrc('components/trainer/TrainerSidebar.tsx');
    expect(source).toContain('/app/trainer/calendar');
    expect(source).toContain('/app/trainer/players');
    expect(source).toContain('/app/trainer/settings');
    expect(source).toContain('/app/trainer/earnings');
  });

  it('ClubSidebar keeps club management routes', () => {
    const source = readSrc('components/club/ClubSidebar.tsx');
    expect(source).toContain('/app/club/calendar');
    expect(source).toContain('/app/club/trainers');
    expect(source).toContain('/app/club/settings');
    expect(source).toContain('/app/club/registrations');
  });

  it('AdminSidebar keeps admin panel routes', () => {
    const source = readSrc('components/admin/AdminSidebar.tsx');
    expect(source).toContain('/app/admin/users');
    expect(source).toContain('/app/admin/academies');
    expect(source).toContain('/app/admin/club-claims');
    expect(source).toContain('/app/admin/pricing');
  });
});
