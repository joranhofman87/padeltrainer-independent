import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { SignupRoleKey } from '@/components/auth/SignupRoleTabs';

const BENEFIT_KEYS: Record<SignupRoleKey, readonly string[]> = {
  trainer: ['bookings', 'players', 'admin'],
  player: ['trainers', 'booking', 'progress'],
  club: ['trainers', 'members', 'activity'],
  academy: ['trainers', 'locations', 'scale'],
};

interface SignupValuePanelProps {
  role: SignupRoleKey;
}

export function SignupValuePanel({ role }: SignupValuePanelProps) {
  const { t } = useTranslation('auth');
  const prefix = `${role}Signup`;

  return (
    <div className="space-y-5" data-testid={`signup-value-panel-${role}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-primary">
        {t(`${prefix}.stepEyebrow`)}
      </p>
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {t(`${prefix}.headline`)}
        </h1>
        <p className="text-sm text-muted-foreground sm:text-base">
          {t(`${prefix}.valueSubtitle`)}
        </p>
      </div>
      <ul className="space-y-3">
        {BENEFIT_KEYS[role].map((key) => (
          <li key={key} className="flex items-start gap-3 text-sm text-foreground">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span>{t(`${prefix}.benefits.${key}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
