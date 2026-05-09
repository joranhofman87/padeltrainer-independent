/**
 * Lightweight month view for the Agenda.
 *
 * Shows a calendar month grid. Each day cell shows the total session
 * count and up to 4 trainer dots (color from `getTrainerHue`). Clicking
 * a day jumps to the Day view at that date.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  format, parseISO, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays,
  isSameMonth, isToday,
} from 'date-fns';
import { nl, es, de, fr, enUS, it as itLocale, type Locale } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { getTrainerHue } from './agendaTokens';
import type { AgendaSlot } from './AgendaWeekByTrainer';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS, it: itLocale };

interface Props {
  slots: AgendaSlot[];
  currentDate: Date;
  onDayClick?: (day: Date) => void;
}

export default function AgendaMonth({ slots, currentDate, onDayClick }: Props) {
  const { i18n, t } = useTranslation('academy');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const days = useMemo(() => {
    const list: Date[] = [];
    let cur = gridStart;
    while (cur <= gridEnd) {
      list.push(cur);
      cur = addDays(cur, 1);
    }
    return list;
  }, [gridStart, gridEnd]);

  const byDay = useMemo(() => {
    const map = new Map<string, AgendaSlot[]>();
    slots.forEach((s) => {
      const key = format(parseISO(s.start_time), 'yyyy-MM-dd');
      const arr = map.get(key) || [];
      arr.push(s);
      map.set(key, arr);
    });
    return map;
  }, [slots]);

  const weekDayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, i) => format(addDays(gridStart, i), 'EEE', { locale: dateFnsLocale })),
    [gridStart, dateFnsLocale],
  );

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b bg-muted/30">
        {weekDayLabels.map((label) => (
          <div
            key={label}
            className="px-2 py-2 text-[10px] uppercase tracking-wide text-muted-foreground font-medium text-center"
          >
            {label}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 auto-rows-fr">
        {days.map((day, idx) => {
          const inMonth = isSameMonth(day, currentDate);
          const today = isToday(day);
          const key = format(day, 'yyyy-MM-dd');
          const daySlots = byDay.get(key) || [];

          // unique trainers (up to 4 dots)
          const trainers = Array.from(
            new Map(daySlots.filter((s) => s.trainer_id).map((s) => [s.trainer_id!, s])).values(),
          );

          return (
            <button
              key={key + idx}
              type="button"
              onClick={() => onDayClick?.(day)}
              className={cn(
                'min-h-[88px] sm:min-h-[104px] border-b border-r last:border-r-0 p-2 text-left transition-colors',
                'hover:bg-accent/30',
                !inMonth && 'bg-muted/20 text-muted-foreground/60',
                today && 'bg-primary/5',
                idx % 7 === 6 && 'border-r-0',
              )}
            >
              <div className="flex items-baseline justify-between">
                <span
                  className={cn(
                    'text-sm font-display tabular-nums',
                    today ? 'text-primary font-bold' : inMonth ? 'text-foreground' : 'text-muted-foreground/60',
                  )}
                >
                  {format(day, 'd')}
                </span>
                {daySlots.length > 0 && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {daySlots.length}
                  </span>
                )}
              </div>

              {trainers.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {trainers.slice(0, 4).map((s, i) => {
                    const hue = getTrainerHue(s.trainer_id, i);
                    return <span key={s.trainer_id} className={cn('h-1.5 w-1.5 rounded-full', hue.ring)} />;
                  })}
                  {trainers.length > 4 && (
                    <span className="text-[9px] text-muted-foreground/70">+{trainers.length - 4}</span>
                  )}
                </div>
              )}

              {daySlots.length > 0 && (
                <div className="mt-1 hidden sm:block text-[10px] text-muted-foreground truncate">
                  {daySlots.length === 1
                    ? t('calendar.unitSession', 'session')
                    : t('calendar.unitSessions', 'sessions')}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
