import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Calendar,
  CalendarDays,
  FileText,
  User,
  Users,
} from 'lucide-react';

export type PlayerNavItemId =
  | 'dashboard'
  | 'bookings'
  | 'agenda'
  | 'invoices'
  | 'profile'
  | 'following'
  | 'playground';

export interface PlayerNavItem {
  id: PlayerNavItemId;
  to: string;
  end?: boolean;
  labelKey: string;
  defaultLabel: string;
  icon: LucideIcon;
  testId: string;
  external?: boolean;
}

export const PLAYER_PRIMARY_NAV: PlayerNavItem[] = [
  {
    id: 'dashboard',
    to: '/app/player',
    end: true,
    labelKey: 'nav.dashboard',
    defaultLabel: 'Dashboard',
    icon: LayoutDashboard,
    testId: 'nav-player-dashboard',
  },
  {
    id: 'bookings',
    to: '/app/player/bookings',
    labelKey: 'nav.bookings',
    defaultLabel: 'My trainings',
    icon: Calendar,
    testId: 'nav-player-bookings',
  },
  {
    id: 'agenda',
    to: '/app/player/agenda',
    labelKey: 'nav.agenda',
    defaultLabel: 'Agenda',
    icon: CalendarDays,
    testId: 'nav-player-agenda',
  },
  {
    id: 'invoices',
    to: '/app/player/invoices',
    labelKey: 'nav.invoices',
    defaultLabel: 'Invoices',
    icon: FileText,
    testId: 'nav-player-invoices',
  },
  {
    id: 'profile',
    to: '/app/player/profile',
    labelKey: 'nav.profile',
    defaultLabel: 'My Profile',
    icon: User,
    testId: 'nav-player-profile',
  },
  {
    id: 'following',
    to: '/app/player/following',
    labelKey: 'nav.following',
    defaultLabel: 'Trainers I follow',
    icon: Users,
    testId: 'nav-player-following',
  },
];

export function isPlayerNavItemActive(pathname: string, item: PlayerNavItem): boolean {
  if (item.end) {
    return pathname === item.to;
  }
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
