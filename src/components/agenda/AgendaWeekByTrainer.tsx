/**
 * Week-by-trainer swimlane view.
 *
 * The default Agenda view for academies. Shows a 7-day grid with one row
 * per trainer. Each cell summarises that trainer's day with a session
 * count + occupancy dots. Mobile collapses to a vertical "today + next 6"
 * stack with sessions grouped per trainer per day.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO, startOfWeek, endOfWeek, addDays, isToday, isBefore, isSameDay } from 'date-fns';
import { nl, es, de, fr, enUS, it as itLocale, type Locale } from 'date-fns/locale';
import { ChevronDown } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { getTrainerHue, getFillState, fillStateClasses } from './agendaTokens';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS, it: itLocale };

export interface AgendaSlot {
  id: string;
  start_time: string;
  end_time: string;
  trainer_id: string | null;
  trainer_name: string;
  trainer_avatar: string | null;
  max_participants: number;
  booked_count: number;
  location_id?: string | null;
  location_name?: string | null;
  location_logo?: string | null;
  is_public: boolean;
}

interface TrainerOption {
  id: string;
  name: string;
  avatar: string | null;
}

interface SummaryStats {
  activeTrainers: { id: string; name: string; avatar: string | null }[];
  activeLocations: { id: string; name: string; logo: string | null }[];
  bookedHours: number;
  freeHours: number;
}

interface Props {
  slots: AgendaSlot[];
  trainers: TrainerOption[];
  currentDate: Date;
  summary?: SummaryStats;
  onCellClick?: (trainerId: string, day: Date) => void;
  onTrainerClick?: (trainerId: string) => void;
  onDayHeaderClick?: (day: Date) => void;
  onSlotClick?: (slotId: string) => void;
}

function fmtH(h: number): string {
  if (h <= 0) return '0h';
  return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
}

function durationHours(start: string, end: string): number {
  const s = parseISO(start).getTime();
  const e = parseISO(end).getTime();
  return Math.max(0, (e - s) / 3_600_000);
}

export default function AgendaWeekByTrainer({
  slots, trainers, currentDate, onCellClick, onTrainerClick, onDayHeaderClick, onSlotClick,
}: Props) {
  const { t, i18n } = useTranslation('academy');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;
  const now = new Date();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const weekStart = useMemo(() => startOfWeek(currentDate, { weekStartsOn: 1 }), [currentDate]);
  const weekEnd = useMemo(() => endOfWeek(currentDate, { weekStartsOn: 1 }), [currentDate]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const weekSlots = useMemo(
    () =>
      slots.filter((s) => {
        const d = parseISO(s.start_time);
        return d >= weekStart && d <= weekEnd;
      }),
    [slots, weekStart, weekEnd],
  );

  // trainerId -> dayKey -> slots[]
  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, AgendaSlot[]>>();
    trainers.forEach((tr) => {
      const inner = new Map<string, AgendaSlot[]>();
      weekDays.forEach((d) => inner.set(format(d, 'yyyy-MM-dd'), []));
      map.set(tr.id, inner);
    });
    weekSlots.forEach((s) => {
      if (!s.trainer_id) return;
      const inner = map.get(s.trainer_id);
      if (!inner) return;
      const key = format(parseISO(s.start_time), 'yyyy-MM-dd');
      const arr = inner.get(key);
      if (!arr) return;
      arr.push(s);
    });
    map.forEach((inner) => inner.forEach((arr) => arr.sort((a, b) => a.start_time.localeCompare(b.start_time))));
    return map;
  }, [trainers, weekDays, weekSlots]);

  // Only show trainers that have at least one session this week, fall back
  // to showing all if nothing is scheduled (so the grid never collapses).
  const visibleTrainers = useMemo(() => {
    const withSessions = trainers.filter((tr) => {
      const inner = grouped.get(tr.id);
      if (!inner) return false;
      for (const arr of inner.values()) if (arr.length > 0) return true;
      return false;
    });
    return withSessions.length > 0 ? withSessions : trainers;
  }, [trainers, grouped]);

  // Footer totals
  const totals = useMemo(() => {
    const sessions = weekSlots.length;
    const hours = weekSlots.reduce((acc, s) => acc + durationHours(s.start_time, s.end_time), 0);
    const totalSeats = weekSlots.reduce((a, s) => a + (s.max_participants || 0), 0);
    const filledSeats = weekSlots.reduce((a, s) => a + Math.min(s.booked_count, s.max_participants || 0), 0);
    const fillRate = totalSeats > 0 ? Math.round((filledSeats / totalSeats) * 100) : 0;
    return { sessions, hours, fillRate };
  }, [weekSlots]);

  const trainerWeekHours = (trainerId: string) => {
    const inner = grouped.get(trainerId);
    if (!inner) return 0;
    let h = 0;
    for (const arr of inner.values()) for (const s of arr) h += durationHours(s.start_time, s.end_time);
    return h;
  };

  const renderCell = (trainer: TrainerOption, day: Date) => {
    const dayKey = format(day, 'yyyy-MM-dd');
    const slotsForCell = grouped.get(trainer.id)?.get(dayKey) || [];
    const count = slotsForCell.length;
    const isPast = slotsForCell.length > 0 && slotsForCell.every((s) => isBefore(parseISO(s.end_time), now));
    const totalSeats = slotsForCell.reduce((a, s) => a + (s.max_participants || 0), 0);
    const totalBooked = slotsForCell.reduce((a, s) => a + Math.min(s.booked_count, s.max_participants || 0), 0);
    const state = count === 0 ? 'empty' : getFillState({ bookedCount: totalBooked, maxParticipants: totalSeats || 1, isPast });
    const cls = fillStateClasses[state];

    return (
      <button
        key={trainer.id + dayKey}
        type="button"
        onClick={() => onCellClick?.(trainer.id, day)}
        className={cn(
          'group relative h-16 sm:h-20 w-full rounded-md border text-left px-2 py-1.5 transition-all',
          cls.bg,
          cls.border,
          'hover:border-primary/40 hover:shadow-sm',
        )}
      >
        {count === 0 ? (
          <span className="text-[11px] text-muted-foreground/60">·</span>
        ) : (
          <div className="flex h-full flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className={cn('text-sm font-display font-semibold tabular-nums', cls.text)}>{count}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {count === 1 ? t('calendar.unitSession', 'session') : t('calendar.unitSessions', 'sessions')}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-[3px]">
              {slotsForCell.slice(0, 6).map((s) => {
                const sState = getFillState({
                  bookedCount: s.booked_count,
                  maxParticipants: s.max_participants || 1,
                  isPast: isBefore(parseISO(s.end_time), now),
                });
                return (
                  <span
                    key={s.id}
                    className={cn('h-1.5 w-1.5 rounded-full', fillStateClasses[sState].dot)}
                  />
                );
              })}
              {slotsForCell.length > 6 && (
                <span className="text-[9px] text-muted-foreground/70">+{slotsForCell.length - 6}</span>
              )}
            </div>
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      {/* ── Desktop grid ── */}
      <div className="hidden md:block overflow-x-auto">
        <div className="min-w-[820px]">
          {/* Header row */}
          <div className="grid grid-cols-[180px_repeat(7,minmax(0,1fr))_72px] border-b bg-muted/30">
            <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              {t('calendar.trainer', 'Trainer')}
            </div>
            {weekDays.map((day) => {
              const today = isToday(day);
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  onClick={() => onDayHeaderClick?.(day)}
                  className={cn(
                    'px-2 py-2 text-center transition-colors hover:bg-accent/40',
                    today && 'bg-primary/5',
                  )}
                >
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {format(day, 'EEE', { locale: dateFnsLocale })}
                  </div>
                  <div className={cn('text-sm font-display font-semibold tabular-nums', today && 'text-primary')}>
                    {format(day, 'd')}
                  </div>
                </button>
              );
            })}
            <div className="px-2 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium text-right">
              {t('calendar.total', 'Total')}
            </div>
          </div>

          {/* Trainer rows */}
          {visibleTrainers.map((tr, i) => {
            const hue = getTrainerHue(tr.id, i);
            const initials = tr.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || '?';
            const firstName = tr.name.split(' ')[0];
            const hours = trainerWeekHours(tr.id);
            const isExpanded = expanded.has(tr.id);
            return (
              <div key={tr.id} className="border-b last:border-b-0">
                <div className="grid grid-cols-[180px_repeat(7,minmax(0,1fr))_72px] items-center gap-1 px-1 py-2">
                  <div className="flex items-center gap-1 min-w-0">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(tr.id)}
                      aria-label={isExpanded ? t('calendar.collapse', 'Collapse') : t('calendar.expand', 'Expand')}
                      aria-expanded={isExpanded}
                      className="p-1 rounded hover:bg-accent/40 transition-colors shrink-0"
                    >
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 text-muted-foreground transition-transform',
                          isExpanded && 'rotate-180',
                        )}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => onTrainerClick?.(tr.id)}
                      className="flex items-center gap-2 px-1.5 py-1 text-left rounded-md hover:bg-accent/40 transition-colors min-w-0 flex-1"
                    >
                      <span className={cn('h-7 w-1 rounded-full shrink-0', hue.ring)} />
                      <Avatar className="h-7 w-7 shrink-0">
                        <AvatarImage src={tr.avatar || undefined} alt={tr.name} />
                        <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium truncate">{firstName}</span>
                    </button>
                  </div>
                  {weekDays.map((day) => renderCell(tr, day))}
                  <div className="px-2 text-right text-xs tabular-nums text-muted-foreground">
                    {hours > 0 ? `${hours.toFixed(hours % 1 === 0 ? 0 : 1)}h` : '·'}
                  </div>
                </div>

                {isExpanded && (
                  <div className="grid grid-cols-[180px_repeat(7,minmax(0,1fr))_72px] gap-1 px-1 pb-3 bg-muted/10 border-t">
                    <div className="px-2 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t('calendar.sessions', 'Sessions')}
                    </div>
                    {weekDays.map((day) => {
                      const dayKey = format(day, 'yyyy-MM-dd');
                      const slotsForCell = grouped.get(tr.id)?.get(dayKey) || [];
                      return (
                        <div key={tr.id + dayKey + 'exp'} className="pt-2 min-w-0">
                          {slotsForCell.length === 0 ? (
                            <div className="text-[11px] text-muted-foreground/50 px-1">·</div>
                          ) : (
                            <ul className="space-y-1">
                              {slotsForCell.map((s) => {
                                const sState = getFillState({
                                  bookedCount: s.booked_count,
                                  maxParticipants: s.max_participants || 1,
                                  isPast: isBefore(parseISO(s.end_time), now),
                                });
                                return (
                                  <li key={s.id}>
                                    <button
                                      type="button"
                                      onClick={() => onSlotClick?.(s.id)}
                                      className={cn(
                                        'w-full text-left px-1.5 py-1 rounded border text-[11px] leading-tight transition-colors hover:border-primary/40',
                                        fillStateClasses[sState].bg,
                                        fillStateClasses[sState].border,
                                      )}
                                    >
                                      <div className="flex items-center justify-between gap-1">
                                        <span className="tabular-nums font-medium truncate">
                                          {format(parseISO(s.start_time), 'HH:mm')}
                                        </span>
                                        <span className="tabular-nums text-muted-foreground shrink-0">
                                          {s.booked_count}/{s.max_participants}
                                        </span>
                                      </div>
                                      {s.location_name && (
                                        <div className="text-[10px] text-muted-foreground truncate">
                                          {s.location_name}
                                        </div>
                                      )}
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                    <div />
                  </div>
                )}
              </div>
            );
          })}

          {visibleTrainers.length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              {t('calendar.empty.noTrainers', 'No trainers in this academy yet.')}
            </div>
          )}
        </div>
      </div>

      {/* ── Mobile stack ── */}
      <div className="md:hidden divide-y">
        {weekDays.map((day) => {
          const today = isToday(day);
          const dayKey = format(day, 'yyyy-MM-dd');
          const trainersForDay = visibleTrainers
            .map((tr, i) => ({
              tr,
              i,
              slots: grouped.get(tr.id)?.get(dayKey) || [],
            }))
            .filter((x) => x.slots.length > 0);

          return (
            <div key={day.toISOString()} className={cn('px-3 py-3', today && 'bg-primary/5')}>
              <button
                type="button"
                onClick={() => onDayHeaderClick?.(day)}
                className="flex items-baseline gap-2 mb-2 text-left"
              >
                <span className={cn('text-base font-display font-semibold', today && 'text-primary')}>
                  {format(day, 'EEEE', { locale: dateFnsLocale })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {format(day, 'd MMM', { locale: dateFnsLocale })}
                </span>
                {today && (
                  <span className="text-[10px] uppercase tracking-wide text-primary font-medium ml-1">
                    {t('calendar.todayShort', 'Today')}
                  </span>
                )}
              </button>

              {trainersForDay.length === 0 && (
                <p className="text-xs text-muted-foreground/70 italic">
                  {t('calendar.empty.noSessions', 'No sessions')}
                </p>
              )}

              <div className="space-y-2">
                {trainersForDay.map(({ tr, i, slots: trainerSlots }) => {
                  const hue = getTrainerHue(tr.id, i);
                  const initials = tr.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || '?';
                  return (
                    <div key={tr.id} className="rounded-lg border bg-background overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b bg-muted/20">
                        <span className={cn('h-5 w-1 rounded-full', hue.ring)} />
                        <Avatar className="h-6 w-6">
                          <AvatarImage src={tr.avatar || undefined} alt={tr.name} />
                          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium truncate">{tr.name.split(' ')[0]}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {trainerSlots.length} {trainerSlots.length === 1 ? t('calendar.unitSession', 'session') : t('calendar.unitSessions', 'sessions')}
                        </span>
                      </div>
                      <ul className="divide-y">
                        {trainerSlots.map((s) => {
                          const sState = getFillState({
                            bookedCount: s.booked_count,
                            maxParticipants: s.max_participants || 1,
                            isPast: isBefore(parseISO(s.end_time), now),
                          });
                          return (
                            <li key={s.id}>
                              <button
                                type="button"
                                onClick={() => onSlotClick?.(s.id)}
                                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-accent/30 transition-colors"
                              >
                                <div className="min-w-0">
                                  <div className="text-sm tabular-nums">
                                    {format(parseISO(s.start_time), 'HH:mm')}
                                    {' – '}
                                    {format(parseISO(s.end_time), 'HH:mm')}
                                  </div>
                                  {s.location_name && (
                                    <div className="text-[11px] text-muted-foreground truncate">{s.location_name}</div>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className={cn('h-1.5 w-1.5 rounded-full', fillStateClasses[sState].dot)} />
                                  <span className="text-xs text-muted-foreground tabular-nums">
                                    {s.booked_count}/{s.max_participants}
                                  </span>
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer totals */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
        <span>
          <strong className="text-foreground tabular-nums">{totals.sessions}</strong>{' '}
          {totals.sessions === 1 ? t('calendar.unitSession', 'session') : t('calendar.unitSessions', 'sessions')}
        </span>
        <span aria-hidden>·</span>
        <span>
          <strong className="text-foreground tabular-nums">{totals.hours.toFixed(totals.hours % 1 === 0 ? 0 : 1)}</strong> h
        </span>
        <span aria-hidden>·</span>
        <span>
          <strong className="text-foreground tabular-nums">{totals.fillRate}%</strong>{' '}
          {t('calendar.filled', 'filled')}
        </span>
      </div>
    </div>
  );
}
