import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { SignupRoleTabs, type SignupRoleKey } from '@/components/auth/SignupRoleTabs';

interface SignupPageShellProps {
  /** Omit on /app/signup hub so every tab is a link. */
  activeRole?: SignupRoleKey;
  pageTestId: string;
  children: React.ReactNode;
}

export function SignupPageShell({ activeRole, pageTestId, children }: SignupPageShellProps) {
  const { t } = useTranslation('auth');

  return (
    <div
      className="flex min-h-screen flex-col items-center bg-background px-4 py-6 sm:py-10"
      data-testid={pageTestId}
    >
      <div className="w-full max-w-md space-y-6">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('backToHome', 'Back to home')}
        </Link>
        <Link to="/" className="inline-flex" aria-label="PadelTrainer.ai">
          <Logo className="h-8" />
        </Link>
        <SignupRoleTabs activeRole={activeRole} />
        {children}
      </div>
    </div>
  );
}
