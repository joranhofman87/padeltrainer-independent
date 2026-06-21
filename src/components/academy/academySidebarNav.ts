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

// The registrations list lives at /registrations, but creating/editing a
// registration still routes through the shared /cycles/* CRUD pages — keep the
// nav item highlighted there too.
const REGISTRATIONS_SECTION_PREFIXES = [
  '/app/academy/registrations',
  '/app/academy/cycles',
] as const;

export function isAcademyNavItemActive(pathname: string, item: AcademyNavItem): boolean {
  if (item.id === 'settings') {
    return SETTINGS_SECTION_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  }
  if (item.id === 'registrations') {
    return REGISTRATIONS_SECTION_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  }
  if (item.end) {
    return pathname === item.to;
  }
  return pathname.startsWith(item.to);
}
