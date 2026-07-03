import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

interface AppMobileHeaderProps {
  /** Role-specific title content (name / logo / actions) rendered in the truncating slot. */
  children: ReactNode;
  /** Accessible label for the menu button — passed from the caller's own i18n namespace. */
  menuLabel: string;
  /**
   * Visibility breakpoint class — each role passes the class matching ITS sidebar's
   * collapse point. Every role sidebar is the shared shadcn sidebar (mobile Sheet
   * below md/768px, desktop rail from md up), so this is `md:hidden` for all roles.
   */
  breakpointClass: string;
  /** Header element test id, e.g. "trainer-mobile-header". */
  'data-testid'?: string;
  /** Menu button test id, e.g. "trainer-mobile-menu-trigger" (referenced by tests). */
  menuTriggerTestId: string;
}

/**
 * Shared sticky mobile app header used by every role layout. The menu button
 * toggles the sidebar via useSidebar().toggleSidebar — deliberately NOT
 * SidebarTrigger (see src/test/appSidebarMigration.test.ts) so it opens the
 * mobile Sheet drawer with the layouts' established behavior.
 */
export function AppMobileHeader({
  children,
  menuLabel,
  breakpointClass,
  'data-testid': dataTestId,
  menuTriggerTestId,
}: AppMobileHeaderProps) {
  const { toggleSidebar } = useSidebar();

  return (
    <header
      className={cn(
        'sticky top-0 z-40 flex h-14 min-w-0 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-white/80',
        breakpointClass,
      )}
      data-testid={dataTestId}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={toggleSidebar}
        aria-label={menuLabel}
        data-testid={menuTriggerTestId}
      >
        <Menu className="h-5 w-5" />
      </Button>
      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{children}</span>
    </header>
  );
}
