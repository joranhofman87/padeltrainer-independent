import { useTranslation } from 'react-i18next';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Weekday } from '@/lib/slotPlan';

/**
 * Multi-select weekday picker for the slot generator — which days of the week to
 * plan on. Neutral (trainer + academy); emits the `Weekday[]` `planSlots` expects.
 * Reuses the existing `application.form.days.*` cycles i18n keys (en + nl) so day
 * labels match the rest of the cycle UI.
 */
const DAYS: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export interface WeekdayToggleProps {
  value: Weekday[];
  onChange: (value: Weekday[]) => void;
  disabled?: boolean;
}

export function WeekdayToggle({ value, onChange, disabled }: WeekdayToggleProps) {
  const { t } = useTranslation('cycles');
  return (
    <ToggleGroup
      type="multiple"
      value={value}
      onValueChange={(next) => onChange(next as Weekday[])}
      disabled={disabled}
      className="flex flex-wrap justify-start gap-1"
    >
      {DAYS.map((day) => {
        const label = t(`application.form.days.${day}`);
        return (
          <ToggleGroupItem key={day} value={day} aria-label={label} className="capitalize">
            {label}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
