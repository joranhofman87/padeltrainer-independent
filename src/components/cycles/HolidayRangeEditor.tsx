import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/format';
import { CalendarIcon, Plus, Trash2 } from 'lucide-react';

export interface HolidayRange {
  name: string;
  from: string;
  to: string;
}

interface Props {
  holidays: HolidayRange[];
  onChange: (next: HolidayRange[]) => void;
}

/**
 * Holiday-period editor shared by the rebook wizards. Dates are stored as
 * `YYYY-MM-DD` strings (the shape the bulk-rebook edge function expects); the
 * UI uses the app's calendar pop-up instead of a native date input.
 */
export function HolidayRangeEditor({ holidays, onChange }: Props) {
  const { t } = useTranslation('cycles');

  const add = () => onChange([...holidays, { name: '', from: '', to: '' }]);
  const update = (i: number, patch: Partial<HolidayRange>) =>
    onChange(holidays.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  const remove = (i: number) => onChange(holidays.filter((_, idx) => idx !== i));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('rebookShared.holidaysTitle', 'Vakanties (geen training)')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t('rebookShared.holidaysHint', 'Geef vakantieperiodes op. Op deze dagen wordt niets ingepland.')}
        </p>
        {holidays.map((h, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
            <div>
              <Label className="text-xs">{t('rebookShared.holidayName', 'Naam')}</Label>
              <Input
                value={h.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder={t('rebookShared.holidayNamePlaceholder', 'bv. Herfstvakantie')}
              />
            </div>
            <HolidayDateField
              label={t('rebookShared.holidayFrom', 'Van')}
              value={h.from}
              // Clear an end date that would now precede the new start.
              onSelect={(iso) => update(i, { from: iso, ...(h.to && iso && h.to < iso ? { to: '' } : {}) })}
            />
            <HolidayDateField
              label={t('rebookShared.holidayTo', 'Tot en met')}
              value={h.to}
              minIso={h.from || undefined}
              onSelect={(iso) => update(i, { to: iso })}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              aria-label={t('rebookShared.removeHoliday', 'Verwijderen')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={add}>
          <Plus className="h-4 w-4 mr-1" /> {t('rebookShared.addHoliday', 'Vakantie toevoegen')}
        </Button>
      </CardContent>
    </Card>
  );
}

function HolidayDateField({
  label,
  value,
  minIso,
  onSelect,
}: {
  label: string;
  value: string;
  minIso?: string;
  onSelect: (iso: string) => void;
}) {
  const { t } = useTranslation('cycles');
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn('w-full sm:w-[160px] justify-start text-left font-normal', !value && 'text-muted-foreground')}
          >
            <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
            {value ? formatDate(parseISO(value), 'PPP') : t('rebookShared.pickDate', 'Kies een datum')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value ? parseISO(value) : undefined}
            onSelect={(d) => onSelect(d ? format(d, 'yyyy-MM-dd') : '')}
            disabled={minIso ? (date) => date < parseISO(minIso) : undefined}
            initialFocus
            className="p-3 pointer-events-auto"
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
