import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { LiveWindow, OnboardingResponsesRow } from '@/lib/onboardingResponses';

const LIVE_WINDOWS: LiveWindow[] = ['this_week', 'two_weeks', 'one_month', 'exploring'];

export interface CriticalEventFormValues {
  target_live_window: LiveWindow;
  critical_event_note: string;
}

interface OnboardingStepCriticalEventProps {
  initialData: OnboardingResponsesRow | null;
  onBack: () => void;
  onComplete: (values: CriticalEventFormValues) => Promise<void>;
  isSaving: boolean;
}

function mapInitial(row: OnboardingResponsesRow | null): CriticalEventFormValues {
  return {
    target_live_window: (row?.target_live_window as LiveWindow | null) ?? 'two_weeks',
    critical_event_note: row?.critical_event_note ?? '',
  };
}

export function OnboardingStepCriticalEvent({
  initialData,
  onBack,
  onComplete,
  isSaving,
}: OnboardingStepCriticalEventProps) {
  const { t } = useTranslation('onboarding');
  const [values, setValues] = useState<CriticalEventFormValues>(() => mapInitial(initialData));

  useEffect(() => {
    setValues(mapInitial(initialData));
  }, [initialData]);

  const canProceed = !!values.target_live_window;

  const handleSubmit = async () => {
    if (!canProceed) return;
    await onComplete(values);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center sm:text-left">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('spiced.criticalEvent.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('spiced.criticalEvent.subtitle')}</p>
      </div>

      <div className="space-y-5">
        <div className="space-y-2">
          <Label>{t('spiced.criticalEvent.liveWindowLabel')}</Label>
          <div className="grid gap-2">
            {LIVE_WINDOWS.map((window) => (
              <button
                key={window}
                type="button"
                onClick={() => setValues((v) => ({ ...v, target_live_window: window }))}
                className={cn(
                  'w-full rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors',
                  values.target_live_window === window
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/40',
                )}
              >
                {t(`spiced.criticalEvent.liveWindow.${window}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="critical_event_note">{t('spiced.criticalEvent.noteLabel')}</Label>
          <Textarea
            id="critical_event_note"
            value={values.critical_event_note}
            onChange={(e) => setValues((v) => ({ ...v, critical_event_note: e.target.value }))}
            placeholder={t('spiced.criticalEvent.notePlaceholder')}
            rows={3}
          />
          <p className="text-xs text-muted-foreground">{t('spiced.criticalEvent.noteHint')}</p>
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="outline" onClick={onBack} disabled={isSaving}>
          {t('spiced.common.back')}
        </Button>
        <Button
          type="button"
          size="lg"
          className="w-full sm:w-auto"
          disabled={!canProceed || isSaving}
          onClick={handleSubmit}
        >
          {isSaving ? t('spiced.common.saving') : t('spiced.common.continue')}
        </Button>
      </div>
    </div>
  );
}
