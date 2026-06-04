import { describe, it, expect } from 'vitest';
import { ACADEMY_PRIMARY_NAV, isAcademyNavItemActive } from './academySidebarNav';

describe('academySidebarNav', () => {
  it('lists all primary nav destinations', () => {
    expect(ACADEMY_PRIMARY_NAV.map((item) => item.id)).toEqual([
      'dashboard',
      'schedule',
      'players',
      'registrations',
      'invoices',
      'settings',
    ]);
  });

  it('uses existing routes without new paths', () => {
    expect(ACADEMY_PRIMARY_NAV.map((item) => item.to)).toEqual([
      '/app/academy',
      '/app/academy/calendar',
      '/app/academy/players',
      '/app/academy/cycles',
      '/app/academy/invoices',
      '/app/academy/settings',
    ]);
  });

  it('marks settings active on profile, locations, and trainers pages', () => {
    const settings = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'settings')!;
    expect(isAcademyNavItemActive('/app/academy/settings', settings)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/settings/notifications', settings)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/profile', settings)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/locations', settings)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/trainers', settings)).toBe(true);
  });

  it('marks dashboard active only on exact index path', () => {
    const dashboard = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'dashboard')!;
    expect(isAcademyNavItemActive('/app/academy', dashboard)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/players', dashboard)).toBe(false);
  });
});
