import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check, Circle, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ShareableProfileLink } from '@/components/profile/ShareableProfileLink';
import { cn } from '@/lib/utils';
import {
  computeTrainerProfileSetupComplete,
  computeTrainerPublishComplete,
} from '@/lib/trainerSetupPlan';

export interface DashboardSetupStats {
  openSlots: number;
  totalStudents: number;
}

export interface DashboardSetupProfileFields {
  fullName: string | null;
  bio: string | null;
  hourlyRate: number | null;
  isPublic: boolean;
  slug: string | null;
}

interface DashboardSetupBannerProps {
  setupFields: DashboardSetupProfileFields;
  shortUrl: string | null;
  stats: DashboardSetupStats;
  upcomingSlotsCount: number;
  recentBookingsCount: number;
  showPaymentsStep: boolean;
  paymentsComplete: boolean;
}

export function DashboardSetupBanner({
  setupFields,
  shortUrl,
  stats,
  upcomingSlotsCount,
  recentBookingsCount,
  showPaymentsStep,
  paymentsComplete,
}: DashboardSetupBannerProps) {
  const { t } = useTranslation('trainer');
  const navigate = useNavigate();

  const steps = useMemo(() => {
    const profileDone = computeTrainerProfileSetupComplete({
      fullName: setupFields.fullName,
      bio: setupFields.bio,
      hourlyRate: setupFields.hourlyRate,
    });
    const scheduleDone = stats.openSlots > 0 || upcomingSlotsCount > 0;
    const playersDone = stats.totalStudents > 0 || recentBookingsCount > 0;
    const paymentsDone = paymentsComplete;
    const publishDone = computeTrainerPublishComplete({
      isPublic: setupFields.isPublic,
      slug: setupFields.slug,
    });

    return [
      {
        id: 'profile',
        done: profileDone,
        title: t('dashboard.setup.steps.profile.title'),
        description: t('dashboard.setup.steps.profile.description'),
        action: () => navigate('/app/trainer/profile'),
      },
      {
        id: 'schedule',
        done: scheduleDone,
        title: t('dashboard.setup.steps.availability.title'),
        description: t('dashboard.setup.steps.availability.description'),
        action: () => navigate('/app/trainer/slot/new'),
      },
      {
        id: 'players',
        done: playersDone,
        title: t('dashboard.setup.steps.players.title'),
        description: t('dashboard.setup.steps.players.description'),
        action: () => navigate('/app/trainer/players'),
      },
      ...(showPaymentsStep
        ? [
            {
              id: 'payments',
              done: paymentsDone,
              title: t('dashboard.setup.steps.payments.title'),
              description: t('dashboard.setup.steps.payments.description'),
              action: () => navigate('/app/trainer/earnings'),
            },
          ]
        : []),
      {
        id: 'publish',
        done: publishDone,
        title: t('dashboard.setup.steps.publish.title'),
        description: t('dashboard.setup.steps.publish.description'),
        action: () => navigate('/app/trainer/settings'),
      },
    ];
  }, [
    setupFields,
    stats.openSlots,
    stats.totalStudents,
    upcomingSlotsCount,
    recentBookingsCount,
    showPaymentsStep,
    paymentsComplete,
    t,
    navigate,
  ]);

  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  const isEmpty =
    stats.openSlots === 0 &&
    upcomingSlotsCount === 0 &&
    stats.totalStudents === 0 &&
    recentBookingsCount === 0;

  const showBanner = completed < total && (isEmpty || completed < Math.max(2, total - 1));
  if (!showBanner) return null;

  const nextStep = steps.find((s) => !s.done);
  const trainerSlug = setupFields.slug;

  return (
    <section
      className="rounded-lg border border-[hsl(var(--navy-100))] bg-[hsl(var(--navy-50))]/60 p-4 sm:p-5"
      aria-label={t('dashboard.setup.title')}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold text-[hsl(var(--navy-900))]">
            {t('dashboard.setup.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.setup.description')}</p>
          <p className="mt-2 text-xs font-medium text-[hsl(var(--navy-600))]">
            {t('dashboard.setup.progress', { completed, total })}
          </p>
        </div>
        {nextStep && (
          <Button
            size="sm"
            className="shrink-0 bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-600))]"
            onClick={nextStep.action}
          >
            {nextStep.title}
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        )}
      </div>

      <ul className="mt-4 space-y-2">
        {steps.map((step) => (
          <li key={step.id}>
            <button
              type="button"
              onClick={step.action}
              className={cn(
                'flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors',
                !step.done && 'hover:bg-background/80',
              )}
            >
              {step.done ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--brand-600))]" />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0">
                <span
                  className={cn(
                    'block text-sm font-medium',
                    step.done ? 'text-muted-foreground line-through' : 'text-[hsl(var(--navy-900))]',
                  )}
                >
                  {step.title}
                </span>
                {!step.done && (
                  <span className="block text-xs text-muted-foreground">{step.description}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {trainerSlug && (
        <div className="mt-4 border-t border-[hsl(var(--navy-100))] pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('dashboard.shareLink')}
          </p>
          <ShareableProfileLink handle={trainerSlug} shortUrl={shortUrl ?? undefined} compact />
        </div>
      )}
    </section>
  );
}
