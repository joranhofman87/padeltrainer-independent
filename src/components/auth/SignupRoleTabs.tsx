import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const ROLES = [
  { key: 'trainer', path: '/app/signup/trainer', testId: 'signup-tab-trainer' },
  { key: 'player', path: '/app/signup/player', testId: 'signup-tab-player' },
  { key: 'club', path: '/app/signup/club', testId: 'signup-tab-club' },
  { key: 'academy', path: '/app/signup/academy', testId: 'signup-tab-academy' },
] as const;

export type SignupRoleKey = (typeof ROLES)[number]['key'];

export function buildSignupRolePath(base: string, redirect: string | null): string {
  return redirect ? `${base}?redirect=${encodeURIComponent(redirect)}` : base;
}

interface SignupRoleTabsProps {
  /** When omitted (e.g. /app/signup hub), all roles render as links. */
  activeRole?: SignupRoleKey;
  className?: string;
}

export function SignupRoleTabs({ activeRole, className }: SignupRoleTabsProps) {
  const { t } = useTranslation('auth');
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');

  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/40 p-1 sm:grid-cols-4',
        className,
      )}
      role="tablist"
      aria-label={t('signupPicker.subtitle')}
    >
      {ROLES.map(({ key, path, testId }) => {
        const isActive = activeRole != null && key === activeRole;
        const label = t(`signupPicker.roles.${key}.title`);
        const href = buildSignupRolePath(path, redirect);

        if (isActive) {
          return (
            <span
              key={key}
              role="tab"
              aria-selected="true"
              data-testid={testId}
              className={cn(
                'rounded-md px-3 py-2 text-center text-sm font-medium',
                'bg-background text-foreground shadow-sm ring-1 ring-border',
              )}
            >
              {label}
            </span>
          );
        }

        return (
          <Link
            key={key}
            to={href}
            role="tab"
            aria-selected="false"
            data-testid={testId}
            className={cn(
              'rounded-md px-3 py-2 text-center text-sm font-medium text-muted-foreground',
              'transition-colors hover:bg-background/80 hover:text-foreground',
            )}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
