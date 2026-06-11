import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  format, parseISO, startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  differenceInMinutes,
} from 'date-fns';
import { nl, es, de, fr, enUS, it as itLocale, type Locale } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Download, Calendar, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
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
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('calendar.hours.trainer', 'Trainer')}</TableHead>
                <TableHead className="text-center">{t('calendar.hours.sessions', 'Sessions')}</TableHead>
                <TableHead className="text-center">{t('calendar.hours.totalHours', 'Hours')}</TableHead>
                <TableHead className="text-center">{t('calendar.hours.rate', 'Rate')}</TableHead>
                <TableHead className="text-right">{t('calendar.hours.amount', 'Amount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trainerData.map(trainer => {
                const initials = trainer.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
                return (
                  <TableRow key={trainer.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-7 w-7">
                          <AvatarImage src={trainer.avatar || undefined} />
                          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                        </Avatar>
                        <span className="font-medium text-sm">{trainer.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary" className="text-xs">{trainer.sessions}</Badge>
                    </TableCell>
                    <TableCell className="text-center text-sm">{trainer.hours.toFixed(1)}h</TableCell>
                    <TableCell className="text-center text-sm text-muted-foreground">
                      {formatCurrencyMaybe(trainer.hourly_rate)}
                    </TableCell>
                    <TableCell className="text-right text-sm font-medium">
                      {formatCurrencyMaybe(trainer.amount)}
                    </TableCell>
                  </TableRow>
                );
              })}
              {trainerData.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    {t('calendar.hours.noData', 'No sessions with bookings in this period')}
                  </TableCell>
                </TableRow>
              )}
              {trainerData.length > 0 && (
                <TableRow className="font-semibold border-t-2">
                  <TableCell>{t('calendar.hours.total', 'Total')}</TableCell>
                  <TableCell className="text-center">{totalSessions}</TableCell>
                  <TableCell className="text-center">{totalHours.toFixed(1)}h</TableCell>
                  <TableCell />
                  <TableCell className="text-right">{formatCurrency(totalAmount)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
