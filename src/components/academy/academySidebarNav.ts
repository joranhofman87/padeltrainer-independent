import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Calendar,
  CalendarPlus,
  Users,
  UserRoundCog,
  CalendarDays,
  FileText,
  Wallet,
  Settings,
  RefreshCw,
} from 'lucide-react';

export type AcademyNavItemId =
  | 'dashboard'
  | 'schedule'
  | 'sessions'
  | 'players'
  | 'trainers'
  | 'registrations'
  | 'rebook'
  | 'invoices'
  | 'expenses'
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
    id: 'sessions',
    to: '/app/academy/sessions',
    labelKey: 'nav.sessions',
    defaultLabel: 'Sessions',
    icon: CalendarPlus,
    testId: 'nav-academy-sessions',
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
    id: 'rebook',
    to: '/app/academy/rebook',
    labelKey: 'nav.rebook',
    defaultLabel: 'Rebooking',
    icon: RefreshCw,
    testId: 'nav-academy-rebook',
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
    id: 'expenses',
    to: '/app/academy/expenses',
    labelKey: 'nav.expenses',
    defaultLabel: 'Expenses',
    icon: Wallet,
    testId: 'nav-academy-expenses',
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

// The rebook flow lives under /cycles/* (the cohort wizard at /cycles/rebook and the per-round
// manager at /cycles/:id/rebook) but belongs to its own Rebooking nav item now — NOT Sessions.
function isRebookCycleRoute(pathname: string): boolean {
  return (
    pathname === '/app/academy/cycles/rebook' ||
    pathname.startsWith('/app/academy/cycles/rebook/') ||
    // /app/academy/cycles/:cycleId/rebook → the per-round rebook manager.
    /^\/app\/academy\/cycles\/[^/]+\/rebook(\/|$)/.test(pathname)
  );
}

// bulk-copy (copy a term's sessions into a new one) is a Sessions-hub "next round" op — stays there.
function isBulkCopyRoute(pathname: string): boolean {
  return pathname === '/app/academy/cycles/bulk-copy' || pathname.startsWith('/app/academy/cycles/bulk-copy/');
}

// Training-cycle CRUD (/cycles/new, /cycles/:id, /cycles/:id/edit) is a SCHEDULE ("Schema") thing —
// opened from the Schedule's cyclus tab — EXCEPT the rebook + bulk-copy ops (their own nav items).
function isScheduleCycleRoute(pathname: string): boolean {
  return pathname.startsWith('/app/academy/cycles') && !isRebookCycleRoute(pathname) && !isBulkCopyRoute(pathname);
}

export function isAcademyNavItemActive(pathname: string, item: AcademyNavItem): boolean {
  if (item.id === 'settings') {
    return SETTINGS_SECTION_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  }
  if (item.id === 'schedule') {
    return pathname.startsWith(item.to) || isScheduleCycleRoute(pathname);
  }
  if (item.id === 'sessions') {
    // The Sessions hub + the bulk-copy "next round" op launched from it.
    return pathname.startsWith(item.to) || isBulkCopyRoute(pathname);
  }
  if (item.id === 'rebook') {
    // The Rebooking page + the cohort wizard + the per-round rebook manager.
    return pathname.startsWith(item.to) || isRebookCycleRoute(pathname);
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
