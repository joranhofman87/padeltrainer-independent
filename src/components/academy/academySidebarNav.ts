import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Calendar,
  Users,
  CalendarDays,
  FileText,
  Settings,
} from 'lucide-react';

export type AcademyNavItemId =
  | 'dashboard'
  | 'schedule'
  | 'players'
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
    id: 'players',
    to: '/app/academy/players',
    labelKey: 'nav.players',
    defaultLabel: 'Players',
    icon: Users,
    testId: 'nav-academy-players',
  },
  {
    id: 'registrations',
    to: '/app/academy/cycles',
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
  '/app/academy/trainers',
] as const;

export function isAcademyNavItemActive(pathname: string, item: AcademyNavItem): boolean {
  if (item.id === 'settings') {
    return SETTINGS_SECTION_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  }
  if (item.end) {
    return pathname === item.to;
  }
  return pathname.startsWith(item.to);
}
