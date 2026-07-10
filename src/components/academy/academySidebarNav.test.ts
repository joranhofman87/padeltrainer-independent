import { describe, it, expect } from 'vitest';
import { ACADEMY_PRIMARY_NAV, isAcademyNavItemActive } from './academySidebarNav';

describe('academySidebarNav', () => {
  it('lists all primary nav destinations including Trainers', () => {
    expect(ACADEMY_PRIMARY_NAV.map((item) => item.id)).toEqual([
      'dashboard',
      'schedule',
      'sessions',
      'players',
      'trainers',
      'registrations',
      'rebook',
      'invoices',
      'expenses',
      'settings',
    ]);
  });

  it('routes match the primary nav destinations', () => {
    expect(ACADEMY_PRIMARY_NAV.map((item) => item.to)).toEqual([
      '/app/academy',
      '/app/academy/calendar',
      '/app/academy/sessions',
      '/app/academy/players',
      '/app/academy/trainers',
      '/app/academy/registrations',
      '/app/academy/rebook',
      '/app/academy/invoices',
      '/app/academy/expenses',
      '/app/academy/settings',
    ]);
  });

  it('training-cycle pages (/cycles/*) highlight Schedule (Schema), not Registrations', () => {
    const schedule = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'schedule')!;
    const registrations = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'registrations')!;
    for (const path of ['/app/academy/cycles/new', '/app/academy/cycles/abc-123', '/app/academy/cycles/abc-123/edit']) {
      expect(isAcademyNavItemActive(path, schedule)).toBe(true);
      expect(isAcademyNavItemActive(path, registrations)).toBe(false);
    }
    // Registrations highlight only on their own /registrations section.
    expect(isAcademyNavItemActive('/app/academy/registrations', registrations)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/registrations/abc-123/edit', registrations)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/registrations', schedule)).toBe(false);
    // The Schedule page itself still highlights Schedule.
    expect(isAcademyNavItemActive('/app/academy/calendar', schedule)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/players', schedule)).toBe(false);
  });

  it('routes the rebook ops (cohort wizard + :id/rebook) to the Rebooking item, bulk-copy to Sessions', () => {
    const rebook = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'rebook')!;
    const sessions = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'sessions')!;
    const schedule = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'schedule')!;
    // Rebook flow → the Rebooking nav item (its own page + the /cycles rebook ops).
    for (const path of ['/app/academy/rebook', '/app/academy/cycles/rebook', '/app/academy/cycles/abc-123/rebook']) {
      expect(isAcademyNavItemActive(path, rebook)).toBe(true);
      expect(isAcademyNavItemActive(path, sessions)).toBe(false);
      expect(isAcademyNavItemActive(path, schedule)).toBe(false);
    }
    // bulk-copy stays on Sessions; the rebook item does NOT claim it.
    expect(isAcademyNavItemActive('/app/academy/cycles/bulk-copy', sessions)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/cycles/bulk-copy', rebook)).toBe(false);
    // the Sessions hub highlights Sessions; cycle CRUD highlights Schedule (not Sessions/Rebook)
    expect(isAcademyNavItemActive('/app/academy/sessions', sessions)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/cycles/new', sessions)).toBe(false);
    expect(isAcademyNavItemActive('/app/academy/cycles/new', rebook)).toBe(false);
  });

  it('includes Trainers nav item after Players and before Registrations', () => {
    const trainers = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'trainers')!;
    expect(trainers.to).toBe('/app/academy/trainers');
    expect(trainers.testId).toBe('nav-academy-trainers');
    const playersIdx = ACADEMY_PRIMARY_NAV.findIndex((item) => item.id === 'players');
    const registrationsIdx = ACADEMY_PRIMARY_NAV.findIndex((item) => item.id === 'registrations');
    expect(ACADEMY_PRIMARY_NAV.findIndex((item) => item.id === 'trainers')).toBe(playersIdx + 1);
    expect(ACADEMY_PRIMARY_NAV.findIndex((item) => item.id === 'trainers')).toBe(registrationsIdx - 1);
  });

  it('marks trainers active on trainers page', () => {
    const trainers = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'trainers')!;
    expect(isAcademyNavItemActive('/app/academy/trainers', trainers)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/trainers/invite', trainers)).toBe(true);
  });

  it('does not mark settings active on trainers page', () => {
    const settings = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'settings')!;
    expect(isAcademyNavItemActive('/app/academy/trainers', settings)).toBe(false);
  });

  it('marks settings active on profile, locations, and settings pages', () => {
    const settings = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'settings')!;
    expect(isAcademyNavItemActive('/app/academy/settings', settings)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/settings/notifications', settings)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/profile', settings)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/locations', settings)).toBe(true);
  });

  it('marks dashboard active only on exact index path', () => {
    const dashboard = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'dashboard')!;
    expect(isAcademyNavItemActive('/app/academy', dashboard)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/players', dashboard)).toBe(false);
  });
});
