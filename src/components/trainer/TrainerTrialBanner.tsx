import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { getTrialDaysRemaining } from '@/lib/subscription';

interface TrainerTrialBannerProps {
  trialEndsAt: string | null;
  onUpgrade: () => void;
}

export function TrainerTrialBanner({ trialEndsAt, onUpgrade }: TrainerTrialBannerProps) {
  const { t } = useTranslation('trainer');
  const daysRemaining = getTrialDaysRemaining(trialEndsAt);
  const isExpired = daysRemaining === 0;
  
  return (
    <Alert variant={isExpired ? 'destructive' : 'default'} className="mb-6">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between">
        <span>
          {isExpired 
            ? t('dashboard.trialBanner.expired')
            : daysRemaining === 1
              ? t('dashboard.trialBanner.lastDay')
              : t('dashboard.trialBanner.daysLeft', { days: daysRemaining })
          }
        </span>
        <Button size="sm" variant={isExpired ? 'default' : 'outline'} onClick={onUpgrade}>
          {isExpired ? t('dashboard.trialBanner.subscribe') : t('dashboard.trialBanner.upgrade')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
