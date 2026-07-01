/**
 * Lightweight month view for the Agenda.
 *
 * Shows a calendar month grid. Each day cell summarises the day with:
 *  - total session count
 *  - up to 2 location rows (logo + name)
 *  - booked / total seats and a free-spots indicator
 * Clicking a day jumps to the Day view.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  format, parseISO, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays,
  isSameMonth, isToday, isBefore,
} from 'date-fns';
import { nl, es, de, fr, enUS, it as itLocale, type Locale } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { zonedDateKey } from '@/lib/zonedFormat';
import { fillStateClasses, getFillState } from './agendaTokens';
import type { AgendaSlot } from './AgendaWeekByTrainer';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS, it: itLocale };

interface Props {
  slots: AgendaSlot[];
  currentDate: Date;
  onDayClick?: (day: Date) => void;
  /**
   * When set, slots are grouped onto day cells by their day in THIS IANA timezone
   * (the owner's) rather than the browser's — so a near-midnight slot lands on the
   * correct academy-local day on the public availability calendar. Omitted by the
   * admin callers, which keep the original browser-local grouping.
   */
  timezone?: string;
  /** yyyy-MM-dd of the currently-selected day — highlighted (public two-pane calendar). */
  selectedKey?: string | null;
  /**
   * Hide the per-day seat count + free/full badge. Used by the PUBLIC availability calendar,
   * where sessions are booked as a whole (no per-spot capacity to advertise). Admin callers omit
   * it and keep the capacity summary.
   */
  hideCapacity?: boolean;
}

export default function AgendaMonth({ slots, currentDate, onDayClick, timezone, selectedKey, hideCapacity }: Props) {
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
      const key = timezone ? zonedDateKey(s.start_time, timezone) : format(parseISO(s.start_time), 'yyyy-MM-dd');
      const arr = map.get(key) || [];
      arr.push(s);
      map.set(key, arr);
    });
    return map;
  }, [slots, timezone]);

  const weekDayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, i) => format(addDays(gridStart, i), 'EEE', { locale: dateFnsLocale })),
    [gridStart, dateFnsLocale],
  );

  const now = new Date();

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

          // Aggregate per location (id || name as fallback key)
          const locMap = new Map<string, { name: string; logo: string | null; count: number }>();
          daySlots.forEach((s) => {
            const k = s.location_id || s.location_name || '__none__';
            const existing = locMap.get(k);
            if (existing) {
              existing.count += 1;
            } else {
              locMap.set(k, {
                name: s.location_name || t('calendar.noLocation', 'No location'),
                logo: s.location_logo || null,
                count: 1,
              });
            }
          });
          const locations = Array.from(locMap.values()).sort((a, b) => b.count - a.count);

          const totalSeats = daySlots.reduce((a, s) => a + (s.max_participants || 0), 0);
          const bookedSeats = daySlots.reduce(
            (a, s) => a + Math.min(s.booked_count, s.max_participants || 0),
            0,
          );
          const freeSeats = Math.max(0, totalSeats - bookedSeats);
          const isPast = daySlots.length > 0 && daySlots.every((s) => isBefore(parseISO(s.end_time), now));
          const fillState = daySlots.length === 0
            ? 'empty'
            : getFillState({ bookedCount: bookedSeats, maxParticipants: totalSeats || 1, isPast });

          return (
            <button
              key={key + idx}
              type="button"
              onClick={() => onDayClick?.(day)}
              className={cn(
                'min-h-[112px] sm:min-h-[132px] border-b border-r last:border-r-0 p-2 text-left transition-colors flex flex-col gap-1.5',
                'hover:bg-accent/30',
                !inMonth && 'bg-muted/20 text-muted-foreground/60',
                today && 'bg-primary/5',
                selectedKey === key && 'ring-2 ring-inset ring-primary bg-primary/10',
                idx % 7 === 6 && 'border-r-0',
              )}
            >
              {/* Header: date + session count */}
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
                    {daySlots.length} {daySlots.length === 1
                      ? t('calendar.unitSession', 'session')
                      : t('calendar.unitSessions', 'sessions')}
                  </span>
                )}
              </div>

              {/* Location rows */}
              {locations.length > 0 && (
                <div className="space-y-0.5 min-w-0">
                  {locations.slice(0, 2).map((loc, i) => (
                    <div key={i} className="flex items-center gap-1 min-w-0">
                      {loc.logo ? (
                        <img
                          src={loc.logo}
                          alt=""
                          className="h-3.5 w-3.5 rounded-sm object-contain bg-muted shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <span className="h-3.5 w-3.5 rounded-sm bg-muted shrink-0" />
                      )}
                      <span className="text-[10px] text-foreground/80 truncate min-w-0 flex-1">
                        {loc.name}
                      </span>
                      {loc.count > 1 && (
                        <span className="text-[9px] text-muted-foreground tabular-nums shrink-0">
                          ×{loc.count}
                        </span>
                      )}
                    </div>
                  ))}
                  {locations.length > 2 && (
                    <div className="text-[9px] text-muted-foreground/70">
                      +{locations.length - 2} {t('calendar.more', 'more')}
                    </div>
                  )}
                </div>
              )}

              {/* Footer: capacity + free badge */}
              {!hideCapacity && totalSeats > 0 && (
                <div className="mt-auto flex items-center justify-between gap-1">
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {bookedSeats}/{totalSeats}
                  </span>
                  {!isPast && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-[9px] font-medium tabular-nums',
                        fillStateClasses[fillState].bg,
                        fillStateClasses[fillState].border,
                        fillStateClasses[fillState].text,
                      )}
                    >
                      <span className={cn('h-1 w-1 rounded-full', fillStateClasses[fillState].dot)} />
                      {freeSeats === 0
                        ? t('calendar.full', 'Full')
                        : `${freeSeats} ${t('calendar.free', 'free')}`}
                    </span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
