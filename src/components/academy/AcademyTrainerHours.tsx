import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  format, parseISO, startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  differenceInMinutes,
} from 'date-fns';
import { nl, es, de, fr, enUS, it as itLocale, type Locale } from 'date-fns/locale';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { Download, Calendar, CalendarDays } from 'lucide-react';
import { formatCurrency, formatCurrencyMaybe } from '@/lib/format';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS, it: itLocale };

interface TrainerInfo {
  id: string;
  name: string;
  avatar: string | null;
  hourly_rate?: number;
}

interface SlotForHours {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  booked_count: number;
}

interface AcademyTrainerHoursProps {
  slots: SlotForHours[];
  trainers: TrainerInfo[];
  currentDate: Date;
}

export default function AcademyTrainerHours({
  slots, trainers, currentDate,
}: AcademyTrainerHoursProps) {
  const { t, i18n } = useTranslation('academy');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;
  const [period, setPeriod] = useState<'week' | 'month'>('week');

  const rangeStart = period === 'week'
    ? startOfWeek(currentDate, { weekStartsOn: 1 })
    : startOfMonth(currentDate);
  const rangeEnd = period === 'week'
    ? endOfWeek(currentDate, { weekStartsOn: 1 })
    : endOfMonth(currentDate);

  const periodLabel = period === 'week'
    ? `${format(rangeStart, 'd MMM', { locale: dateFnsLocale })} – ${format(rangeEnd, 'd MMM yyyy', { locale: dateFnsLocale })}`
    : format(currentDate, 'MMMM yyyy', { locale: dateFnsLocale });

  // Filter slots in range with at least 1 booking
  const relevantSlots = useMemo(() => {
    return slots.filter(s => {
      const d = parseISO(s.start_time);
      return d >= rangeStart && d <= rangeEnd && s.booked_count > 0;
    });
  }, [slots, rangeStart, rangeEnd]);

  // Aggregate per trainer
  const trainerData = useMemo(() => {
    const map = new Map<string, { sessions: number; totalMinutes: number }>();
    relevantSlots.forEach(s => {
      const existing = map.get(s.trainer_id) || { sessions: 0, totalMinutes: 0 };
      existing.sessions += 1;
      existing.totalMinutes += differenceInMinutes(parseISO(s.end_time), parseISO(s.start_time));
      map.set(s.trainer_id, existing);
    });

    return trainers.map(trainer => {
      const data = map.get(trainer.id) || { sessions: 0, totalMinutes: 0 };
      const hours = data.totalMinutes / 60;
      const amount = trainer.hourly_rate ? hours * trainer.hourly_rate : null;
      return {
        ...trainer,
        sessions: data.sessions,
        hours,
        amount,
      };
    }).sort((a, b) => b.hours - a.hours);
  }, [relevantSlots, trainers]);

  const totalHours = trainerData.reduce((s, t) => s + t.hours, 0);
  const totalSessions = trainerData.reduce((s, t) => s + t.sessions, 0);
  const totalAmount = trainerData.reduce((s, t) => s + (t.amount || 0), 0);

  // The generic engine has no footer slot, so the totals row rides along as a synthetic pinned
  // row (sentinel id) styled bold via rowClassName — keeping column alignment with the data rows.
  type HoursRow = {
    id: string;
    isTotal?: boolean;
    name?: string;
    avatar?: string | null;
    hourly_rate?: number;
    sessions: number;
    hours: number;
    amount: number | null;
  };
  const rows: HoursRow[] = trainerData.length
    ? [
        ...trainerData,
        { id: '__total__', isTotal: true, sessions: totalSessions, hours: totalHours, amount: totalAmount },
      ]
    : [];

  // The total row rides along as a synthetic pinned row (sentinel id); its cells are bolded inline
  // (the generic engine has no footer slot or per-row class here).
  const columns: ColumnDef<HoursRow>[] = [
    {
      key: 'trainer',
      header: t('calendar.hours.trainer', 'Trainer'),
      renderCell: (row) => {
        if (row.isTotal) return <span className="font-semibold">{t('calendar.hours.total', 'Total')}</span>;
        const initials = (row.name || '').split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
        return (
          <div className="flex items-center gap-2">
            <Avatar className="h-7 w-7">
              <AvatarImage src={row.avatar || undefined} />
              <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
            </Avatar>
            <span className="font-medium text-sm">{row.name}</span>
          </div>
        );
      },
    },
    {
      key: 'sessions',
      header: t('calendar.hours.sessions', 'Sessions'),
      align: 'center',
      renderCell: (row) =>
        row.isTotal ? <span className="font-semibold">{row.sessions}</span> : <Badge variant="secondary" className="text-xs">{row.sessions}</Badge>,
    },
    {
      key: 'hours',
      header: t('calendar.hours.totalHours', 'Hours'),
      align: 'center',
      className: 'text-sm',
      renderCell: (row) => (row.isTotal ? <span className="font-semibold">{row.hours.toFixed(1)}h</span> : `${row.hours.toFixed(1)}h`),
    },
    {
      key: 'rate',
      header: t('calendar.hours.rate', 'Rate'),
      align: 'center',
      className: 'text-sm text-muted-foreground',
      renderCell: (row) => (row.isTotal ? '' : formatCurrencyMaybe(row.hourly_rate)),
    },
    {
      key: 'amount',
      header: t('calendar.hours.amount', 'Amount'),
      align: 'right',
      className: 'text-sm font-medium',
      renderCell: (row) => (row.isTotal ? <span className="font-semibold">{formatCurrency(row.amount ?? 0)}</span> : formatCurrencyMaybe(row.amount)),
    },
  ];

  const handleExportCSV = () => {
    const header = 'Trainer,Sessions,Hours,Hourly Rate,Amount\n';
    const rows = trainerData.map(t =>
      `"${t.name}",${t.sessions},${t.hours.toFixed(1)},${t.hourly_rate ?? ''},${t.amount != null ? t.amount.toFixed(2) : ''}`
    ).join('\n');
    const totalsRow = `"TOTAL",${totalSessions},${totalHours.toFixed(1)},,${totalAmount.toFixed(2)}`;
    const csv = header + rows + '\n' + totalsRow;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trainer-hours-${format(rangeStart, 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Period toggle + export */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
            <Button
              variant={period === 'week' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setPeriod('week')}
              className="h-7 text-xs"
            >
              <CalendarDays className="h-3.5 w-3.5 mr-1" />
              {t('calendar.hours.week', 'Week')}
            </Button>
            <Button
              variant={period === 'month' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setPeriod('month')}
              className="h-7 text-xs"
            >
              <Calendar className="h-3.5 w-3.5 mr-1" />
              {t('calendar.hours.month', 'Month')}
            </Button>
          </div>
          <span className="text-sm text-muted-foreground">{periodLabel}</span>
        </div>
        <Button variant="outline" size="sm" onClick={handleExportCSV} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          {t('calendar.hours.export', 'Export CSV')}
        </Button>
      </div>

      {/* Table */}
      <DataTable<HoursRow>
        columns={columns}
        rows={rows}
        compact
        desktopOnly={false}
        cardClassName={flushOnMobileCardClass()}
        empty={t('calendar.hours.noData', 'No sessions with bookings in this period')}
      />
    </div>
  );
}
