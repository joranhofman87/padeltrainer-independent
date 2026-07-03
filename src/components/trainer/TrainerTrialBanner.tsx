import { useTranslation } from 'react-i18next';
import { SubscriptionTrialBanner } from '@/components/ui/subscription-trial-banner';
import { getTrialDaysRemaining } from '@/lib/subscription';

interface TrainerTrialBannerProps {
  trialEndsAt: string | null;
  onUpgrade: () => void;
}

/**
 * Thin trainer wrapper around the shared SubscriptionTrialBanner: keeps the
 * trainer day-granular copy (expired / last day / N days) and CTA labels while
 * the shared component owns the layout/style.
 */
export function TrainerTrialBanner({ trialEndsAt, onUpgrade }: TrainerTrialBannerProps) {
  const { t } = useTranslation('trainer');
  const daysRemaining = getTrialDaysRemaining(trialEndsAt);
  const isExpired = daysRemaining === 0;

  return (
    <SubscriptionTrialBanner
      expired={isExpired}
      message={
        isExpired
          ? t('dashboard.trialBanner.expired')
          : daysRemaining === 1
            ? t('dashboard.trialBanner.lastDay')
            : t('dashboard.trialBanner.daysLeft', { days: daysRemaining })
      }
      ctaLabel={isExpired ? t('dashboard.trialBanner.subscribe') : t('dashboard.trialBanner.upgrade')}
      onCtaClick={onUpgrade}
    />
  );
}
