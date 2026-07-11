import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Props {
  id: string;
  /** Lead time in HOURS before each player's priority deadline (the stored unit). */
  valueHours: number;
  onChange: (hours: number) => void;
  disabled?: boolean;
}

const MAX_HOURS = 336; // 14 days — mirrors the SQL picker's clamp

/**
 * "Send the reminder N hours/days before the deadline" — the per-round lead for the automated
 * non-responder reminder (settings.rebook_reminder_lead_hours). Stored in hours; the unit
 * select is display-only sugar (whole multiples of 24h present as days).
 */
export function RebookReminderLeadField({ id, valueHours, onChange, disabled }: Props) {
  const { t } = useTranslation('cycles');
  const [unit, setUnit] = useState<'hours' | 'days'>(valueHours >= 24 && valueHours % 24 === 0 ? 'days' : 'hours');
  const shown = unit === 'days' ? Math.max(1, Math.round(valueHours / 24)) : valueHours;
  const clamp = (h: number) => Math.min(MAX_HOURS, Math.max(1, Math.round(h)));

  const onValue = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    onChange(clamp(unit === 'days' ? n * 24 : n));
  };
  const onUnit = (next: 'hours' | 'days') => {
    setUnit(next);
    // Keep the STORED hours stable across a unit flip when it maps cleanly; otherwise round to
    // the nearest whole unit so the visible number always matches what will happen.
    if (next === 'days' && valueHours % 24 !== 0) onChange(clamp(Math.max(1, Math.round(valueHours / 24)) * 24));
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t('rebookShared.reminderLeadLabel', 'Wanneer versturen?')}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={1}
          max={unit === 'days' ? MAX_HOURS / 24 : MAX_HOURS}
          value={shown}
          onChange={(e) => onValue(e.target.value)}
          disabled={disabled}
          className="w-24"
        />
        <Select value={unit} onValueChange={(v) => onUnit(v as 'hours' | 'days')} disabled={disabled}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hours">{t('rebookShared.reminderLeadHours', 'uur')}</SelectItem>
            <SelectItem value="days">{t('rebookShared.reminderLeadDays', 'dag(en)')}</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {t('rebookShared.reminderLeadSuffix', 'voor het verlopen van de voorrang')}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('rebookShared.reminderLeadHint', 'Elke speler krijgt de herinnering zodra zijn eigen deadline binnen deze tijd valt (één herinnering per speler).')}
      </p>
    </div>
  );
}
