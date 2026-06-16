import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  format, startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  addWeeks, subWeeks, addMonths, subMonths, parseISO, differenceInMinutes,
} from 'date-fns';
import { nl, es, de, fr, enUS, it as itLocale, type Locale } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Download, Calendar, TrendingUp, Users, AlertTriangle, CalendarX2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/lib/supabaseClient';
import { useQuery } from '@tanstack/react-query';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS, it: itLocale };

interface TrainerOption { id: string; name: string; }
interface LocationOption { id: string; name: string; }

interface AcademyReportsTabProps {
  academyId: string;
  trainers: TrainerOption[];
  locations: LocationOption[];
}

interface SlotRow {
  id: string;
  start_time: string;
  end_time: string;
  trainer_id: string;
  location_id: string | null;
  max_participants: number;
  is_public: boolean;
  price_per_session: number | null;
  booking_count: number;
}

type Timescale = 'weekly' | 'monthly';

export default function AcademyReportsTab({ academyId, trainers, locations }: AcademyReportsTabProps) {
  const { t, i18n } = useTranslation('academy');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;

  const [timescale, setTimescale] = useState<Timescale>('weekly');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [subTab, setSubTab] = useState<'overview' | 'trainer' | 'location'>('overview');

  const rangeStart = timescale === 'weekly'
    ? startOfWeek(currentDate, { weekStartsOn: 1 })
    : startOfMonth(currentDate);
  const rangeEnd = timescale === 'weekly'
    ? endOfWeek(currentDate, { weekStartsOn: 1 })
    : endOfMonth(currentDate);

  const periodLabel = timescale === 'weekly'
    ? `${format(rangeStart, 'd MMM', { locale: dateFnsLocale })} – ${format(rangeEnd, 'd MMM yyyy', { locale: dateFnsLocale })}`
    : format(rangeStart, 'MMMM yyyy', { locale: dateFnsLocale });

  const navigatePrev = () => setCurrentDate(d => timescale === 'weekly' ? subWeeks(d, 1) : subMonths(d, 1));
  const navigateNext = () => setCurrentDate(d => timescale === 'weekly' ? addWeeks(d, 1) : addMonths(d, 1));
  const goToday = () => setCurrentDate(new Date());

  // Fetch slots + booking counts for the period
  const { data: slots = [], isLoading } = useQuery({
    queryKey: ['academy-reports', academyId, rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('availability_slots')
        .select(`
          id, start_time, end_time, trainer_id, location_id,
          max_participants, price_per_session, is_public,
          bookings!inner(id)
        `)
        .eq('academy_profile_id', academyId)
        .gte('start_time', rangeStart.toISOString())
        .lte('start_time', rangeEnd.toISOString());

      if (error) {
        // Retry without inner join for slots with no bookings
        const { data: allSlots, error: err2 } = await supabase
          .from('availability_slots')
          .select(`
            id, start_time, end_time, trainer_id, location_id,
            max_participants, price_per_session, is_public
          `)
          .eq('academy_profile_id', academyId)
          .gte('start_time', rangeStart.toISOString())
          .lte('start_time', rangeEnd.toISOString());

        if (err2) throw err2;

        // Fetch booking counts separately
        const slotIds = (allSlots || []).map(s => s.id);
        const bookingCounts = new Map<string, number>();

        if (slotIds.length > 0) {
          const { data: bookings } = await supabase
            .from('bookings')
            .select('slot_id')
            .in('slot_id', slotIds)
            .in('status', ['confirmed', 'pending']);

          (bookings || []).forEach(b => {
            bookingCounts.set(b.slot_id, (bookingCounts.get(b.slot_id) || 0) + 1);
          });
        }

        return (allSlots || []).map(s => ({
          ...s,
          max_participants: s.max_participants || 4,
          booking_count: bookingCounts.get(s.id) || 0,
        })) as SlotRow[];
      }

      return (data || []).map(s => ({
        ...s,
        max_participants: s.max_participants || 4,
        booking_count: Array.isArray(s.bookings) ? s.bookings.length : 0,
      })) as SlotRow[];
    },
  });

  // Stats
  const stats = useMemo(() => {
    const totalSessions = slots.length;
    const totalCapacity = slots.reduce((s, sl) => s + sl.max_participants, 0);
    const totalBooked = slots.reduce((s, sl) => s + sl.booking_count, 0);
    const fillRate = totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0;
    const openSpots = slots.filter(s => s.is_public && s.booking_count < s.max_participants).length;
    const emptySlots = slots.filter(s => s.booking_count === 0).length;
    const totalHours = slots.filter(s => s.booking_count > 0).reduce((sum, s) => sum + differenceInMinutes(parseISO(s.end_time), parseISO(s.start_time)), 0) / 60;
    const privateSlots = slots.filter(s => !s.is_public).length;
    return { totalSessions, totalCapacity, totalBooked, fillRate, openSpots, emptySlots, totalHours, privateSlots };
  }, [slots]);

  // By trainer
  const trainerRows = useMemo(() => {
    const map = new Map<string, SlotRow[]>();
    slots.forEach(s => {
      const arr = map.get(s.trainer_id) || [];
      arr.push(s);
      map.set(s.trainer_id, arr);
    });
    return [...map.entries()].map(([tid, tSlots]) => {
      const trainer = trainers.find(t => t.id === tid);
      const cap = tSlots.reduce((s, sl) => s + sl.max_participants, 0);
      const booked = tSlots.reduce((s, sl) => s + sl.booking_count, 0);
      const emptySlots = tSlots.filter(s => s.booking_count === 0).length;
      const hours = tSlots.filter(s => s.booking_count > 0).reduce((s, sl) => s + differenceInMinutes(parseISO(sl.end_time), parseISO(sl.start_time)), 0) / 60;
      return {
        name: trainer?.name || 'Unknown',
        sessions: tSlots.length,
        emptySlots,
        booked,
        capacity: cap,
        fillRate: cap > 0 ? Math.round((booked / cap) * 100) : 0,
        hours: Math.round(hours * 10) / 10,
      };
    }).sort((a, b) => b.sessions - a.sessions);
  }, [slots, trainers]);

  // By location
  const locationRows = useMemo(() => {
    const map = new Map<string | null, SlotRow[]>();
    slots.forEach(s => {
      const key = s.location_id || 'none';
      const arr = map.get(key) || [];
      arr.push(s);
      map.set(key, arr);
    });
    return [...map.entries()].map(([lid, lSlots]) => {
      const loc = locations.find(l => l.id === lid);
      const cap = lSlots.reduce((s, sl) => s + sl.max_participants, 0);
      const booked = lSlots.reduce((s, sl) => s + sl.booking_count, 0);
      const emptySlots = lSlots.filter(s => s.booking_count === 0).length;
      const hours = lSlots.filter(s => s.booking_count > 0).reduce((s, sl) => s + differenceInMinutes(parseISO(sl.end_time), parseISO(sl.start_time)), 0) / 60;
      return {
        name: loc?.name || t('reports.noLocation', 'No location'),
        sessions: lSlots.length,
        emptySlots,
        booked,
        capacity: cap,
        fillRate: cap > 0 ? Math.round((booked / cap) * 100) : 0,
        hours: Math.round(hours * 10) / 10,
      };
    }).sort((a, b) => b.sessions - a.sessions);
  }, [slots, locations, t]);

  // CSV export
  const handleExportCSV = useCallback(() => {
    const rows = subTab === 'trainer' ? trainerRows : subTab === 'location' ? locationRows : null;
    let csv = '';

    if (rows) {
      csv = 'Name,Sessions,Empty,Booked,Capacity,Fill Rate %,Hours\n';
      rows.forEach(r => {
        csv += `"${r.name}",${r.sessions},${r.emptySlots},${r.booked},${r.capacity},${r.fillRate},${r.hours}\n`;
      });
    } else {
      csv = 'Slot ID,Start,End,Trainer,Location,Booked,Capacity,Private\n';
      slots.forEach(s => {
        const trName = trainers.find(t => t.id === s.trainer_id)?.name || '';
        const locName = locations.find(l => l.id === s.location_id)?.name || '';
        csv += `"${s.id}","${s.start_time}","${s.end_time}","${trName}","${locName}",${s.booking_count},${s.max_participants},${!s.is_public}\n`;
      });
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${format(rangeStart, 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [subTab, trainerRows, locationRows, slots, trainers, locations, rangeStart]);

  return (
    <div className="space-y-6">
      {/* Period controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous" className="h-8 w-8" onClick={navigatePrev}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-[180px] text-center font-medium text-sm capitalize">
            {periodLabel}
          </div>
          <Button variant="outline" size="icon" aria-label="Next" className="h-8 w-8" onClick={navigateNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={goToday}>
            {t('common:today', 'Today')}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex border rounded-md overflow-hidden">
            <button
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${timescale === 'weekly' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
              onClick={() => setTimescale('weekly')}
            >
              {t('reports.weekly', 'Weekly')}
            </button>
            <button
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${timescale === 'monthly' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
              onClick={() => setTimescale('monthly')}
            >
              {t('reports.monthly', 'Monthly')}
            </button>
          </div>
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={handleExportCSV}>
            <Download className="h-3.5 w-3.5" />
            {t('reports.exportCSV', 'Export CSV')}
          </Button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Calendar className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{isLoading ? '—' : stats.totalSessions}</p>
              <p className="text-xs text-muted-foreground">{t('reports.sessions', 'Sessions')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-destructive/10">
              <CalendarX2 className="h-5 w-5 text-destructive" />
            </div>
            <div>
              <p className="text-2xl font-bold">{isLoading ? '—' : stats.emptySlots}</p>
              <p className="text-xs text-muted-foreground">{t('reports.emptySlots', 'Empty slots')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <TrendingUp className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">{isLoading ? '—' : `${stats.fillRate}%`}</p>
              <p className="text-xs text-muted-foreground">{t('reports.fillRate', 'Fill rate')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">{isLoading ? '—' : stats.openSpots}</p>
              <p className="text-xs text-muted-foreground">{t('reports.openSpots', 'Open spots')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <Users className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">{isLoading ? '—' : `${stats.totalBooked}/${stats.totalCapacity}`}</p>
              <p className="text-xs text-muted-foreground">{t('reports.playersBooked', 'Players booked')}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sub-tabs + table */}
      <Tabs value={subTab} onValueChange={v => setSubTab(v as typeof subTab)}>
        <TabsList className="h-9">
          <TabsTrigger value="overview" className="text-xs sm:text-sm">
            {t('reports.overview', 'Overview')}
          </TabsTrigger>
          <TabsTrigger value="trainer" className="text-xs sm:text-sm">
            {t('reports.byTrainer', 'By Trainer')}
          </TabsTrigger>
          <TabsTrigger value="location" className="text-xs sm:text-sm">
            {t('reports.byLocation', 'By Location')}
          </TabsTrigger>
        </TabsList>

        {/* Overview table */}
        <TabsContent value="overview" className="mt-4">
          {isLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : slots.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                {t('reports.noData', 'No sessions found for this period.')}
              </CardContent>
            </Card>
          ) : (
            <Card className={flushOnMobileCardClass()}>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('reports.date', 'Date')}</TableHead>
                      <TableHead>{t('reports.time', 'Time')}</TableHead>
                      <TableHead>{t('reports.trainer', 'Trainer')}</TableHead>
                      <TableHead>{t('reports.location', 'Location')}</TableHead>
                      <TableHead className="text-right">{t('reports.booked', 'Booked')}</TableHead>
                      <TableHead className="text-right">{t('reports.capacity', 'Capacity')}</TableHead>
                      <TableHead className="text-right">{t('reports.fillPct', 'Fill %')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {slots
                      .sort((a, b) => a.start_time.localeCompare(b.start_time))
                      .map(s => {
                        const fill = s.max_participants > 0 ? Math.round((s.booking_count / s.max_participants) * 100) : 0;
                        return (
                          <TableRow key={s.id}>
                            <TableCell className="text-sm">{format(parseISO(s.start_time), 'EEE d MMM', { locale: dateFnsLocale })}</TableCell>
                            <TableCell className="text-sm tabular-nums">{format(parseISO(s.start_time), 'HH:mm')}–{format(parseISO(s.end_time), 'HH:mm')}</TableCell>
                            <TableCell className="text-sm">{trainers.find(t => t.id === s.trainer_id)?.name || '—'}</TableCell>
                            <TableCell className="text-sm">{locations.find(l => l.id === s.location_id)?.name || '—'}</TableCell>
                            <TableCell className="text-right text-sm">{s.booking_count}</TableCell>
                            <TableCell className="text-right text-sm">{s.max_participants}</TableCell>
                            <TableCell className="text-right text-sm font-medium">
                              <span className={fill >= 100 ? 'text-emerald-600' : fill > 0 ? 'text-amber-600' : 'text-muted-foreground'}>
                                {fill}%
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* By Trainer */}
        <TabsContent value="trainer" className="mt-4">
          {isLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : trainerRows.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                {t('reports.noData', 'No sessions found for this period.')}
              </CardContent>
            </Card>
          ) : (
            <Card className={flushOnMobileCardClass()}>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('reports.trainer', 'Trainer')}</TableHead>
                      <TableHead className="text-right">{t('reports.sessions', 'Sessions')}</TableHead>
                      <TableHead className="text-right">{t('reports.empty', 'Empty')}</TableHead>
                      <TableHead className="text-right">{t('reports.booked', 'Booked')}</TableHead>
                      <TableHead className="text-right">{t('reports.capacity', 'Capacity')}</TableHead>
                      <TableHead className="text-right">{t('reports.fillPct', 'Fill %')}</TableHead>
                      <TableHead className="text-right">{t('reports.hours', 'Hours')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trainerRows.map(r => (
                      <TableRow key={r.name}>
                        <TableCell className="text-sm font-medium">{r.name}</TableCell>
                        <TableCell className="text-right text-sm">{r.sessions}</TableCell>
                        <TableCell className="text-right text-sm">
                          <span className={r.emptySlots > 0 ? 'text-destructive' : 'text-muted-foreground'}>{r.emptySlots}</span>
                        </TableCell>
                        <TableCell className="text-right text-sm">{r.booked}</TableCell>
                        <TableCell className="text-right text-sm">{r.capacity}</TableCell>
                        <TableCell className="text-right text-sm">
                          <span className={r.fillRate >= 100 ? 'text-emerald-600' : r.fillRate > 0 ? 'text-amber-600' : 'text-muted-foreground'}>
                            {r.fillRate}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-sm">{r.hours}h</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* By Location */}
        <TabsContent value="location" className="mt-4">
          {isLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : locationRows.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                {t('reports.noData', 'No sessions found for this period.')}
              </CardContent>
            </Card>
          ) : (
            <Card className={flushOnMobileCardClass()}>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('reports.location', 'Location')}</TableHead>
                      <TableHead className="text-right">{t('reports.sessions', 'Sessions')}</TableHead>
                      <TableHead className="text-right">{t('reports.empty', 'Empty')}</TableHead>
                      <TableHead className="text-right">{t('reports.booked', 'Booked')}</TableHead>
                      <TableHead className="text-right">{t('reports.capacity', 'Capacity')}</TableHead>
                      <TableHead className="text-right">{t('reports.fillPct', 'Fill %')}</TableHead>
                      <TableHead className="text-right">{t('reports.hours', 'Hours')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {locationRows.map(r => (
                      <TableRow key={r.name}>
                        <TableCell className="text-sm font-medium">{r.name}</TableCell>
                        <TableCell className="text-right text-sm">{r.sessions}</TableCell>
                        <TableCell className="text-right text-sm">
                          <span className={r.emptySlots > 0 ? 'text-destructive' : 'text-muted-foreground'}>{r.emptySlots}</span>
                        </TableCell>
                        <TableCell className="text-right text-sm">{r.booked}</TableCell>
                        <TableCell className="text-right text-sm">{r.capacity}</TableCell>
                        <TableCell className="text-right text-sm">
                          <span className={r.fillRate >= 100 ? 'text-emerald-600' : r.fillRate > 0 ? 'text-amber-600' : 'text-muted-foreground'}>
                            {r.fillRate}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-sm">{r.hours}h</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
