import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO, isToday } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { CalendarDays } from 'lucide-react';
import { AgendaListItem } from './AgendaListItem';
import type { AgendaSlot } from '@/lib/agendaSlots';

interface DayGroup {
  key: string;
  label: string;
  isToday: boolean;
  slots: AgendaSlot[];
}

/**
 * Renders the week's sessions as a vertical agenda: a "Today" section first
 * (when showTodaySection), then one section per remaining day. Distinct from the
 * calendar swimlane grid — this is the "what's coming up" list.
 */
export function AgendaList({
  slots,
  basePath,
  showTrainer = false,
  showTodaySection = true,
}: {
  slots: AgendaSlot[];
  basePath: string;
  showTrainer?: boolean;
  showTodaySection?: boolean;
}) {
  const { t, i18n } = useTranslation('common');
  const locale = i18n.language === 'nl' ? nl : enUS;

  const groups = useMemo<DayGroup[]>(() => {
    const byDay = new Map<string, AgendaSlot[]>();
    for (const s of slots) {
      const key = format(parseISO(s.start_time), 'yyyy-MM-dd');
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(s);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, daySlots]) => {
        const d = parseISO(daySlots[0].start_time);
        return {
          key,
          label: format(d, 'EEEE d MMMM', { locale }),
          isToday: isToday(d),
          slots: daySlots,
        };
      });
  }, [slots, locale]);

  if (slots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center text-muted-foreground">
        <CalendarDays className="h-8 w-8 opacity-50" />
        <p>{t('agenda.empty', 'No sessions in this period')}</p>
      </div>
    );
  }

  const today = showTodaySection ? groups.find((g) => g.isToday) : undefined;
  const rest = groups.filter((g) => g !== today);

  return (
    <div className="space-y-6">
      {today && (
        <section className="space-y-2">
          <h2 className="px-1 text-sm font-semibold text-primary">{t('agenda.today', 'Today')}</h2>
          <div className="space-y-2">
            {today.slots.map((s) => (
              <AgendaListItem key={s.id} slot={s} basePath={basePath} showTrainer={showTrainer} />
            ))}
          </div>
        </section>
      )}
      {rest.map((g) => (
        <section key={g.key} className="space-y-2">
          <h2 className="px-1 text-sm font-semibold capitalize text-muted-foreground">{g.label}</h2>
          <div className="space-y-2">
            {g.slots.map((s) => (
              <AgendaListItem key={s.id} slot={s} basePath={basePath} showTrainer={showTrainer} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
