import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { SignupRoleTabs } from '@/components/auth/SignupRoleTabs';
import { TrainerSignupValuePanel } from '@/components/auth/TrainerSignupValuePanel';
import { TrainerSignupSocialProof } from '@/components/auth/TrainerSignupSocialProof';

interface TrainerSignupLayoutProps {
  children: React.ReactNode;
}

export function TrainerSignupLayout({ children }: TrainerSignupLayoutProps) {
  const { t } = useTranslation('auth');

  return (
    <div className="min-h-screen bg-background" data-testid="page-signup-trainer">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:py-10">
        <div className="mb-6 flex flex-col gap-4 sm:mb-8">
          <Link
            to="/"
            className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('backToHome', 'Back to home')}
          </Link>
          <Link to="/" className="inline-flex w-fit" aria-label="PadelTrainer.ai">
            <Logo className="h-8" />
          </Link>
          <SignupRoleTabs activeRole="trainer" />
        </div>

        <div className="flex flex-1 flex-col gap-8 lg:grid lg:grid-cols-2 lg:gap-12 lg:items-start">
          <div className="order-1 flex flex-col gap-6 lg:order-2">
            {children}
          </div>

          <div className="order-2 space-y-6 lg:order-1 lg:sticky lg:top-10">
            <TrainerSignupValuePanel />
            <TrainerSignupSocialProof />
          </div>
        </div>
      </div>
    </div>
  );
}
