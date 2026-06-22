import { describe, it, expect } from 'vitest';
import { ACADEMY_PRIMARY_NAV, isAcademyNavItemActive } from './academySidebarNav';

describe('academySidebarNav', () => {
  it('lists all primary nav destinations including Trainers', () => {
    expect(ACADEMY_PRIMARY_NAV.map((item) => item.id)).toEqual([
      'dashboard',
      'schedule',
      'agenda',
      'players',
      'trainers',
      'registrations',
      'invoices',
      'settings',
    ]);
  });

  it('routes match the primary nav destinations', () => {
    expect(ACADEMY_PRIMARY_NAV.map((item) => item.to)).toEqual([
      '/app/academy',
      '/app/academy/calendar',
      '/app/academy/agenda',
      '/app/academy/players',
      '/app/academy/trainers',
      '/app/academy/registrations',
      '/app/academy/invoices',
      '/app/academy/settings',
    ]);
  });

  it('marks registrations active on both /registrations and the shared /cycles CRUD pages', () => {
    const registrations = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'registrations')!;
    expect(isAcademyNavItemActive('/app/academy/registrations', registrations)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/cycles/new', registrations)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/cycles/abc-123', registrations)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/players', registrations)).toBe(false);
  });

  it('keeps the Agenda cycle-ops (rebook / bulk-copy) under Agenda, not Registrations', () => {
    const registrations = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'registrations')!;
    const agenda = ACADEMY_PRIMARY_NAV.find((item) => item.id === 'agenda')!;
    for (const path of ['/app/academy/cycles/rebook', '/app/academy/cycles/bulk-copy']) {
      expect(isAcademyNavItemActive(path, agenda)).toBe(true);
      expect(isAcademyNavItemActive(path, registrations)).toBe(false);
    }
    // plain /agenda still highlights Agenda; registration CRUD still highlights Registrations
    expect(isAcademyNavItemActive('/app/academy/agenda', agenda)).toBe(true);
    expect(isAcademyNavItemActive('/app/academy/cycles/new', agenda)).toBe(false);
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
