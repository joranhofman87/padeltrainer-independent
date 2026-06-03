import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { CalendarPlus, CheckCircle2 } from 'lucide-react';

interface OnboardingStep2DoneProps {
  onComplete: () => void;
}

export function OnboardingStep2Done({ onComplete }: OnboardingStep2DoneProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('trainer');

  const finishAndGo = (path: string) => {
    onComplete();
    navigate(path);
  };

  return (
    <div className="text-center space-y-8 py-8">
      <div className="flex justify-center">
        <div className="h-20 w-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
          <CheckCircle2 className="h-10 w-10 text-green-500" />
        </div>
      </div>

      <div className="space-y-3">
        <h1 className="text-2xl font-bold">{t('onboarding.done.title')}</h1>
        <p className="text-muted-foreground max-w-md mx-auto">
          {t('onboarding.done.subtitle')}
        </p>
      </div>

      <div className="space-y-3 max-w-sm mx-auto">
        <Button
          size="lg"
          className="w-full"
          onClick={() => finishAndGo('/app/trainer/slot/new')}
        >
          <CalendarPlus className="h-4 w-4 mr-2" />
          {t('onboarding.done.addFirstSlot')}
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          onClick={() => finishAndGo('/app/trainer')}
        >
          {t('onboarding.done.goToDashboard')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
        {t('onboarding.done.hint')}
      </p>
    </div>
  );
}
