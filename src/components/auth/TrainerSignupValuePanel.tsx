import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';

const BENEFIT_KEYS = ['bookings', 'players', 'admin'] as const;

export function TrainerSignupValuePanel() {
  const { t } = useTranslation('auth');

  return (
    <div className="space-y-5">
      <p className="text-xs font-medium uppercase tracking-wide text-primary">
        {t('trainerSignup.stepEyebrow')}
      </p>
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {t('trainerSignup.headline')}
        </h1>
        <p className="text-sm text-muted-foreground sm:text-base">
          {t('trainerSignup.valueSubtitle')}
        </p>
      </div>
      <ul className="space-y-3">
        {BENEFIT_KEYS.map((key) => (
          <li key={key} className="flex items-start gap-3 text-sm text-foreground">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span>{t(`trainerSignup.benefits.${key}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
