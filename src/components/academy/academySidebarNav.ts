import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Calendar,
  CalendarClock,
  Users,
  UserRoundCog,
  CalendarDays,
  FileText,
  Settings,
} from 'lucide-react';

export type AcademyNavItemId =
  | 'dashboard'
  | 'schedule'
  | 'agenda'
  | 'players'
  | 'trainers'
  | 'registrations'
  | 'invoices'
  | 'settings';

export interface AcademyNavItem {
  id: AcademyNavItemId;
  to: string;
  end?: boolean;
  labelKey: string;
  defaultLabel: string;
  icon: LucideIcon;
  testId: string;
}

/** Primary academy sidebar destinations (routes unchanged). */
export const ACADEMY_PRIMARY_NAV: AcademyNavItem[] = [
  {
    id: 'dashboard',
    to: '/app/academy',
    end: true,
    labelKey: 'nav.dashboard',
    defaultLabel: 'Dashboard',
    icon: LayoutDashboard,
    testId: 'nav-academy-dashboard',
  },
  {
    id: 'schedule',
    to: '/app/academy/calendar',
    labelKey: 'nav.schedule',
    defaultLabel: 'Schedule',
    icon: Calendar,
    testId: 'nav-academy-schedule',
  },
  {
    id: 'agenda',
    to: '/app/academy/agenda',
    labelKey: 'nav.agenda',
    defaultLabel: 'Agenda',
    icon: CalendarClock,
    testId: 'nav-academy-agenda',
  },
  {
    id: 'players',
    to: '/app/academy/players',
    labelKey: 'nav.players',
    defaultLabel: 'Players',
    icon: Users,
    testId: 'nav-academy-players',
  },
  {
    id: 'trainers',
    to: '/app/academy/trainers',
    labelKey: 'nav.trainers',
    defaultLabel: 'Trainers',
    icon: UserRoundCog,
    testId: 'nav-academy-trainers',
  },
  {
    id: 'registrations',
    to: '/app/academy/registrations',
    labelKey: 'nav.registrations',
    defaultLabel: 'Registrations',
    icon: CalendarDays,
    testId: 'nav-academy-registrations',
  },
  {
    id: 'invoices',
    to: '/app/academy/invoices',
    labelKey: 'nav.invoices',
    defaultLabel: 'Invoices',
    icon: FileText,
    testId: 'nav-academy-invoices',
  },
  {
    id: 'settings',
    to: '/app/academy/settings',
    labelKey: 'nav.settings',
    defaultLabel: 'Settings',
    icon: Settings,
    testId: 'nav-academy-settings',
  },
];

const SETTINGS_SECTION_PREFIXES = [
  '/app/academy/settings',
  '/app/academy/profile',
  '/app/academy/locations',
] as const;

// Rebook + bulk-copy (incl. /cycles/:id/rebook) live under /cycles/* but are AGENDA operations —
// they act on current cycles' scheduling, are launched from the Agenda, and return there.
const AGENDA_CYCLE_ROUTES = [
  '/app/academy/cycles/rebook',
  '/app/academy/cycles/bulk-copy',
] as const;

function isAgendaCycleRoute(pathname: string): boolean {
  return (
    AGENDA_CYCLE_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/')) ||
    // /app/academy/cycles/:cycleId/rebook → the rebook manager (an Agenda op).
    /^\/app\/academy\/cycles\/[^/]+\/rebook(\/|$)/.test(pathname)
  );
}

// Training-cycle CRUD (/cycles/new, /cycles/:id, /cycles/:id/edit) is a SCHEDULE ("Schema") thing —
// these pages are opened from the Schedule's cyclus tab. Registrations now live entirely under
// /registrations/*, so a training-cycle page must NOT highlight Registrations. (Agenda cycle-ops
// — rebook/bulk-copy — stay under Agenda.)
function isScheduleCycleRoute(pathname: string): boolean {
  return pathname.startsWith('/app/academy/cycles') && !isAgendaCycleRoute(pathname);
}

export function isAcademyNavItemActive(pathname: string, item: AcademyNavItem): boolean {
  if (item.id === 'settings') {
    return SETTINGS_SECTION_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  }
  if (item.id === 'schedule') {
    return pathname.startsWith(item.to) || isScheduleCycleRoute(pathname);
  }
  if (item.id === 'agenda') {
    return pathname.startsWith(item.to) || isAgendaCycleRoute(pathname);
  }
  if (item.id === 'registrations') {
    // Registrations are their own /registrations/* section now — NOT /cycles/*.
    return pathname.startsWith(item.to);
  }
  if (item.end) {
    return pathname === item.to;
  }
  return pathname.startsWith(item.to);
}
