import { useMemo, useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format, differenceInWeeks, parseISO, getDay, eachWeekOfInterval, addDays, isSameDay } from 'date-fns';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/logger';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  ArrowLeft,
  CheckCheck,
  Calendar,
  Users,
  AlertTriangle,
  Clock,
  UserX,
  ScaleIcon,
  Loader2,
  Mail,
  CalendarOff,
  Plus,
  X,
} from 'lucide-react';
import { getAvailableSlotsForCycle, finalizeProposals, sendScheduleNotifications, getCycle, updateCycleSettings, type SlotWithOccupancy, type Cycle, type CycleSettings } from '@/lib/cycles';
import { supabase } from '@/lib/supabaseClient';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// --- Helpers ---

function formatTime(dateStr: string, tz?: string) {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  if (tz) opts.timeZone = tz;
  return new Date(dateStr).toLocaleTimeString([], opts);
}

function formatDayLabel(dateStr: string, locale: string, tz?: string) {
  const d = new Date(dateStr);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'short' };
  if (tz) opts.timeZone = tz;
  return d.toLocaleDateString(locale, opts);
}

function getDateKey(dateStr: string, tz?: string) {
  if (tz) {
    // Format date in the target timezone to get the correct calendar date
    const d = new Date(dateStr);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return parts; // returns YYYY-MM-DD
  }
  return new Date(dateStr).toISOString().slice(0, 10);
}

// --- Analysis types ---

interface TrainerGroup {
  trainerId: string;
  trainerName: string;
  trainerAvatar: string | null;
  days: Map<string, { label: string; slots: SlotWithOccupancy[] }>;
  totalSlots: number;
  totalPlayers: number;
}

interface Warning {
  type: 'empty' | 'solo' | 'rating-gap' | 'imbalance';
  icon: typeof AlertTriangle;
  message: string;
}

type PageStatus = 'idle' | 'booking' | 'booked' | 'sending' | 'notified';

// --- Component ---

export default function ProposalOverviewPage() {
  const { t, i18n } = useTranslation('cycles');
  const location = useLocation();
  const navigate = useNavigate();

  const stateSlots: SlotWithOccupancy[] = (location.state as any)?.slots ?? [];
  const cycleId: string | undefined = (location.state as any)?.cycleId;
  const backPath: string = (location.state as any)?.backPath ?? -1;
  const stateTimezone: string | undefined = (location.state as any)?.timezone;

  const [fetchedSlots, setFetchedSlots] = useState<SlotWithOccupancy[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pageStatus, setPageStatus] = useState<PageStatus>('idle');
  const [tz, setTz] = useState<string | undefined>(stateTimezone);
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [excludedDates, setExcludedDates] = useState<string[]>([]);
  const [holidayPickerOpen, setHolidayPickerOpen] = useState(false);

  // Fetch cycle data
  useEffect(() => {
    if (!cycleId) return;
    getCycle(cycleId).then(c => {
      if (c) {
        setCycle(c);
        setExcludedDates(c.settings?.excluded_dates ?? []);
      }
    }).catch((err) => logger.error('Failed to load cycle', err));
  }, [cycleId]);

  // If no slots were passed via state, fetch them using cycleId
  useEffect(() => {
    if (stateSlots.length === 0 && cycleId) {
      setIsLoading(true);
      getAvailableSlotsForCycle(cycleId)
        .then(setFetchedSlots)
        .catch((err) => logger.error('Failed to load slots', err))
        .finally(() => setIsLoading(false));
    }
  }, [cycleId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch timezone from cycle's owner if not passed in state
  useEffect(() => {
    if (tz || !cycleId) return;
    (async () => {
      try {
        const cycle = await getCycle(cycleId);
        if (!cycle) return;
        const table = cycle.owner_type === 'academy' ? 'academy_profiles' : 'trainer_profiles';
        const { data } = await supabase.from(table).select('timezone').eq('id', cycle.owner_id).maybeSingle();
        if ((data as any)?.timezone) setTz((data as any).timezone);
      } catch {}
    })();
  }, [cycleId, tz]);

  const slots = stateSlots.length > 0 ? stateSlots : (fetchedSlots ?? []);
  const cycleSlots = useMemo(() => slots.filter(s => !s.is_blocked), [slots]);

  const { trainerGroups, totalSlots, totalAssigned, totalEmpty, warnings } = useMemo(() => {
    const groupMap = new Map<string, TrainerGroup>();

    for (const slot of cycleSlots) {
      let group = groupMap.get(slot.trainer_id);
      if (!group) {
        group = {
          trainerId: slot.trainer_id,
          trainerName: slot.trainer_name,
          trainerAvatar: slot.trainer_avatar,
          days: new Map(),
          totalSlots: 0,
          totalPlayers: 0,
        };
        groupMap.set(slot.trainer_id, group);
      }

      const dateKey = getDateKey(slot.start_time, tz);
      let day = group.days.get(dateKey);
      if (!day) {
        day = { label: formatDayLabel(slot.start_time, i18n.language, tz), slots: [] };
        group.days.set(dateKey, day);
      }
      day.slots.push(slot);
      group.totalSlots++;
      group.totalPlayers += slot.current_assignments.length;
    }

    // Sort slots within each day
    for (const group of groupMap.values()) {
      for (const day of group.days.values()) {
        day.slots.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
      }
    }

    const sorted = Array.from(groupMap.values()).sort((a, b) => {
      const aFirst = Array.from(a.days.keys()).sort()[0] ?? '';
      const bFirst = Array.from(b.days.keys()).sort()[0] ?? '';
      return aFirst.localeCompare(bFirst) || a.trainerName.localeCompare(b.trainerName);
    });
    const totalSlots = cycleSlots.length;
    const totalAssigned = cycleSlots.reduce((sum, s) => sum + s.current_assignments.length, 0);
    const totalEmpty = cycleSlots.filter(s => s.current_assignments.length === 0).length;

    // Build warnings
    const warnings: Warning[] = [];

    if (totalEmpty > 0) {
      warnings.push({
        type: 'empty',
        icon: Clock,
        message: t('overview.warningEmpty', { count: totalEmpty, defaultValue: '{{count}} slots have no players assigned' }),
      });
    }

    const soloCount = cycleSlots.filter(s => s.current_assignments.length === 1).length;
    if (soloCount > 0) {
      warnings.push({
        type: 'solo',
        icon: UserX,
        message: t('overview.warningSolo', { count: soloCount, defaultValue: '{{count}} slots have only 1 player (group training needs 2+)' }),
      });
    }

    let ratingGapCount = 0;
    for (const slot of cycleSlots) {
      const ratings = slot.current_assignments
        .map(a => a.player_rating)
        .filter((r): r is number => r != null);
      if (ratings.length >= 2) {
        const gap = Math.max(...ratings) - Math.min(...ratings);
        if (gap > 2) ratingGapCount++;
      }
    }
    if (ratingGapCount > 0) {
      warnings.push({
        type: 'rating-gap',
        icon: ScaleIcon,
        message: t('overview.warningRatingGap', { count: ratingGapCount, defaultValue: '{{count}} slots have a rating gap larger than 2 points' }),
      });
    }

    if (sorted.length >= 2) {
      const slotCounts = sorted.map(g => g.totalSlots);
      const maxSlots = Math.max(...slotCounts);
      const minSlots = Math.min(...slotCounts);
      if (maxSlots > 0 && minSlots > 0 && maxSlots / minSlots > 2) {
        const maxTrainer = sorted.find(g => g.totalSlots === maxSlots)!;
        const minTrainer = sorted.find(g => g.totalSlots === minSlots)!;
        warnings.push({
          type: 'imbalance',
          icon: Users,
          message: t('overview.warningImbalance', {
            max: maxTrainer.trainerName,
            maxCount: maxSlots,
            min: minTrainer.trainerName,
            minCount: minSlots,
            defaultValue: 'Workload imbalance: {{max}} has {{maxCount}} slots vs {{min}} with {{minCount}} slots',
          }),
        });
      }
    }

    return { trainerGroups: sorted, totalSlots, totalAssigned, totalEmpty, warnings };
  }, [cycleSlots, i18n.language, t]);

  // --- Holiday helpers ---
  const totalWeeks = useMemo(() => {
    if (!cycle) return 0;
    return differenceInWeeks(parseISO(cycle.end_date), parseISO(cycle.start_date));
  }, [cycle]);

  const handleAddHoliday = useCallback(async (date: Date | undefined) => {
    if (!date || !cycleId || !cycle) return;
    const dateStr = format(date, 'yyyy-MM-dd');
    if (excludedDates.includes(dateStr)) return;
    const newDates = [...excludedDates, dateStr].sort();
    setExcludedDates(newDates);
    setHolidayPickerOpen(false);
    try {
      await updateCycleSettings(cycleId, { ...cycle.settings, excluded_dates: newDates });
    } catch (err) {
      logger.error('Failed to save excluded dates', err);
      setExcludedDates(excludedDates); // rollback
      toast.error('Failed to save holiday date');
    }
  }, [cycleId, cycle, excludedDates]);

  const handleRemoveHoliday = useCallback(async (dateStr: string) => {
    if (!cycleId || !cycle) return;
    const newDates = excludedDates.filter(d => d !== dateStr);
    setExcludedDates(newDates);
    try {
      await updateCycleSettings(cycleId, { ...cycle.settings, excluded_dates: newDates });
    } catch (err) {
      logger.error('Failed to save excluded dates', err);
      setExcludedDates(excludedDates); // rollback
      toast.error('Failed to save holiday date');
    }
  }, [cycleId, cycle, excludedDates]);

  /** Count effective sessions for a slot's weekday, given excluded dates */
  const getEffectiveSessions = useCallback((slotStartTime: string) => {
    if (!cycle) return { total: totalWeeks, effective: totalWeeks, excluded: 0 };
    const start = parseISO(cycle.start_date);
    const end = parseISO(cycle.end_date);
    const slotDay = new Date(slotStartTime).getDay(); // 0=Sun ... 6=Sat
    const matchingHolidays = excludedDates.filter(d => {
      const hDate = parseISO(d);
      return hDate.getDay() === slotDay && hDate >= start && hDate <= end;
    }).length;
    return { total: totalWeeks, effective: totalWeeks - matchingHolidays, excluded: matchingHolidays };
  }, [cycle, excludedDates, totalWeeks]);


  const handleBack = () => {
    if (typeof backPath === 'string') {
      navigate(backPath);
    } else {
      navigate(-1);
    }
  };

  const handleApproveAndBook = async () => {
    if (!cycleId) return;
    setPageStatus('booking');
    try {
      const result = await finalizeProposals(cycleId);
      if (result.errors.length > 0) {
        toast.warning(
          t('overview.bookingPartialSuccess', {
            booked: result.booked,
            bookings: result.bookings_created,
            errors: result.errors.length,
            defaultValue: '{{booked}} registrations booked ({{bookings}} bookings created), {{errors}} errors',
          })
        );
      } else {
        toast.success(
          t('overview.bookingSuccess', {
            booked: result.booked,
            bookings: result.bookings_created,
            defaultValue: '{{booked}} registrations booked, {{bookings}} bookings created',
          })
        );
      }
      setPageStatus('booked');
    } catch (err: any) {
      logger.error('Error finalizing proposals:', err);
      toast.error(err.message || 'Failed to finalize proposals');
      setPageStatus('idle');
    }
  };

  const handleSendEmails = async () => {
    if (!cycleId) return;
    setPageStatus('sending');
    try {
      const result = await sendScheduleNotifications(cycleId);
      if (result.errors.length > 0) {
        toast.warning(
          t('overview.emailPartialSuccess', {
            sent: result.sent,
            errors: result.errors.length,
            defaultValue: '{{sent}} emails sent, {{errors}} failed',
          })
        );
      } else {
        toast.success(
          t('overview.emailSuccess', {
            sent: result.sent,
            defaultValue: '{{sent}} schedule emails sent successfully!',
          })
        );
      }
      setPageStatus('notified');
    } catch (err: any) {
      logger.error('Error sending schedule emails:', err);
      toast.error(err.message || 'Failed to send emails');
      setPageStatus('booked');
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6 flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isProcessing = pageStatus === 'booking' || pageStatus === 'sending';

  return (
    <div className="container mx-auto px-4 py-6 space-y-6 pb-24 sm:pb-6">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold">
              {t('overview.title', { defaultValue: 'Proposal Overview' })}
            </h1>
            <p className="text-sm text-muted-foreground hidden sm:block">
              {t('overview.subtitle', { defaultValue: 'Review the full planning before confirming' })}
            </p>
          </div>
        </div>
        <div className="hidden sm:flex gap-2">
          {(pageStatus === 'booked' || pageStatus === 'sending') && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={isProcessing}>
                  {isProcessing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Mail className="h-4 w-4 mr-1" />}
                  {t('overview.sendEmails', { defaultValue: 'Send Schedule Emails' })}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('overview.sendEmailsTitle', { defaultValue: 'Send schedule emails?' })}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('overview.sendEmailsDescription', {
                      count: totalAssigned,
                      defaultValue: 'This will send an email to all {{count}} assigned players with their training schedule and an invitation to create their account.',
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('overview.cancel', { defaultValue: 'Cancel' })}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleSendEmails}>
                    {t('overview.confirmSendEmails', { defaultValue: 'Send Emails' })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {pageStatus === 'notified' && (
            <Badge variant="secondary" className="text-sm py-2 px-3">
              <CheckCheck className="h-4 w-4 mr-1" />
              {t('overview.allDone', { defaultValue: 'Bookings confirmed & emails sent' })}
            </Badge>
          )}
          {(pageStatus === 'idle' || pageStatus === 'booking') && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={isProcessing || totalAssigned === 0}>
                  {pageStatus === 'booking' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCheck className="h-4 w-4 mr-1" />}
                  {t('proposals.approveAll', { defaultValue: 'Approve & Book all' })}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('overview.approveTitle', { defaultValue: 'Approve & book all proposals?' })}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('overview.approveDescription', {
                      slots: totalSlots,
                      players: totalAssigned,
                      defaultValue: 'This will confirm all {{players}} player assignments across {{slots}} slots and create their bookings. This action cannot be undone.',
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('overview.cancel', { defaultValue: 'Cancel' })}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleApproveAndBook}>
                    {t('overview.confirmApprove', { defaultValue: 'Approve & Book' })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* Status banner */}
      {pageStatus === 'booked' && (
        <Alert className="border-green-500/30 bg-green-500/5">
          <CheckCheck className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-sm">
            {t('overview.bookedBanner', { defaultValue: 'All proposals have been booked! You can now send schedule emails to notify players.' })}
          </AlertDescription>
        </Alert>
      )}
      {pageStatus === 'notified' && (
        <Alert className="border-green-500/30 bg-green-500/5">
          <Mail className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-sm">
            {t('overview.notifiedBanner', { defaultValue: 'All schedule emails have been sent! Players can create their accounts to view their bookings.' })}
          </AlertDescription>
        </Alert>
      )}

      {/* Cycle info & holidays */}
      {cycle && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <div>
              <span className="text-muted-foreground">{t('overview.period', { defaultValue: 'Period' })}:</span>{' '}
              <span className="font-medium">
                {format(parseISO(cycle.start_date), 'd MMM yyyy')} — {format(parseISO(cycle.end_date), 'd MMM yyyy')}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('overview.weeks', { defaultValue: 'Weeks' })}:</span>{' '}
              <span className="font-medium">{totalWeeks}</span>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CalendarOff className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{t('overview.holidayDates', { defaultValue: 'Holiday dates' })}</span>
              <Popover open={holidayPickerOpen} onOpenChange={setHolidayPickerOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                    <Plus className="h-3 w-3" />
                    {t('overview.addDate', { defaultValue: 'Add date' })}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarComponent
                    mode="single"
                    onSelect={handleAddHoliday}
                    disabled={(date) => {
                      const dateStr = format(date, 'yyyy-MM-dd');
                      const start = parseISO(cycle.start_date);
                      const end = parseISO(cycle.end_date);
                      return date < start || date > end || excludedDates.includes(dateStr);
                    }}
                    defaultMonth={parseISO(cycle.start_date)}
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>
            {excludedDates.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {excludedDates.map(d => (
                  <Badge key={d} variant="secondary" className="text-xs gap-1 pr-1">
                    {format(parseISO(d), 'd MMM yyyy')}
                    <button
                      onClick={() => handleRemoveHoliday(d)}
                      className="ml-0.5 rounded-full hover:bg-muted p-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('overview.noHolidays', { defaultValue: 'No holiday dates set. All weeks will have sessions.' })}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard icon={Calendar} label={t('overview.totalSlots', { defaultValue: 'Total slots' })} value={totalSlots} />
        <SummaryCard icon={Users} label={t('overview.playersAssigned', { defaultValue: 'Players assigned' })} value={totalAssigned} />
        <SummaryCard icon={Clock} label={t('overview.emptySlots', { defaultValue: 'Empty slots' })} value={totalEmpty} variant={totalEmpty > 0 ? 'warning' : 'default'} />
        <SummaryCard icon={Users} label={t('overview.trainers', { defaultValue: 'Trainers' })} value={trainerGroups.length} />
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((w, i) => (
            <Alert key={i} className="border-yellow-500/30 bg-yellow-500/5">
              <AlertTriangle className="h-4 w-4 text-yellow-600" />
              <AlertDescription className="text-sm">{w.message}</AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      {/* Per-trainer breakdown */}
      {trainerGroups.length > 0 ? (
        <Accordion type="multiple" defaultValue={trainerGroups.map(g => g.trainerId)} className="space-y-3">
          {trainerGroups.map((group) => (
            <AccordionItem key={group.trainerId} value={group.trainerId} className="border rounded-lg px-4">
              <AccordionTrigger className="hover:no-underline py-3">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={group.trainerAvatar || undefined} />
                    <AvatarFallback className="text-xs">
                      {group.trainerName.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="font-semibold text-sm">{group.trainerName}</span>
                  <Badge variant="secondary" className="text-xs ml-auto mr-2">
                    {group.totalSlots} slots · {group.totalPlayers} players
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4">
                  {Array.from(group.days.entries())
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([dateKey, day]) => (
                      <div key={dateKey}>
                        <p className="text-xs font-medium text-muted-foreground capitalize mb-2">
                          {day.label}
                        </p>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-[120px] h-8 text-xs">{t('overview.time', { defaultValue: 'Time' })}</TableHead>
                              <TableHead className="h-8 text-xs">{t('overview.players', { defaultValue: 'Players' })}</TableHead>
                              <TableHead className="w-[60px] h-8 text-xs text-right">{t('overview.size', { defaultValue: 'Size' })}</TableHead>
                              {cycle && <TableHead className="w-[80px] h-8 text-xs text-right">{t('overview.sessions', { defaultValue: 'Sessions' })}</TableHead>}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {day.slots.map((slot) => {
                              const ratings = slot.current_assignments
                                .map(a => a.player_rating)
                                .filter((r): r is number => r != null);
                              const ratingGap = ratings.length >= 2 ? Math.max(...ratings) - Math.min(...ratings) : 0;
                              const hasIssue = slot.current_assignments.length === 0 || slot.current_assignments.length === 1 || ratingGap > 2;

                              return (
                                <TableRow key={slot.id} className={hasIssue ? 'bg-yellow-500/5' : ''}>
                                  <TableCell className="py-2 text-sm tabular-nums">
                                    {formatTime(slot.start_time, tz)} – {formatTime(slot.end_time, tz)}
                                  </TableCell>
                                  <TableCell className="py-2">
                                    <div className="flex flex-wrap gap-1">
                                      {slot.current_assignments.length > 0 ? (
                                        slot.current_assignments.map((a) => (
                                          <Badge key={a.id} variant="outline" className="text-xs font-normal">
                                            {a.player_name}
                                            {a.player_rating != null && (
                                              <span className="ml-1 text-muted-foreground">({a.player_rating})</span>
                                            )}
                                          </Badge>
                                        ))
                                      ) : (
                                        <span className="text-xs text-muted-foreground italic">
                                          {t('overview.noPlayers', { defaultValue: 'No players' })}
                                        </span>
                                      )}
                                    </div>
                                    {ratingGap > 2 && (
                                      <p className="text-xs text-yellow-600 mt-1">
                                        ⚠ {t('overview.ratingGapInline', { gap: ratingGap.toFixed(1), defaultValue: 'Rating gap: {{gap}}' })}
                                      </p>
                                    )}
                                  </TableCell>
                                  <TableCell className="py-2 text-sm text-right font-medium">
                                    {slot.current_assignments.length}
                                    {slot.max_participants && (
                                      <span className="text-muted-foreground">/{slot.max_participants}</span>
                                    )}
                                  </TableCell>
                                  {cycle && (() => {
                                    const sess = getEffectiveSessions(slot.start_time);
                                    return (
                                      <TableCell className="py-2 text-sm text-right tabular-nums">
                                        <span className="font-medium">{sess.effective}</span>
                                        {sess.excluded > 0 && (
                                          <span className="text-muted-foreground text-xs ml-0.5">/{sess.total}</span>
                                        )}
                                      </TableCell>
                                    );
                                  })()}
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-12">
          {t('overview.noData', { defaultValue: 'No proposals to show. Go back and generate proposals first.' })}
        </p>
      )}

      {/* Sticky mobile bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t sm:hidden z-50">
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t('overview.back', { defaultValue: 'Back' })}
          </Button>
          {(pageStatus === 'booked' || pageStatus === 'sending') ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button className="flex-1" disabled={isProcessing}>
                  {isProcessing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Mail className="h-4 w-4 mr-1" />}
                  {t('overview.sendEmails', { defaultValue: 'Send Emails' })}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('overview.sendEmailsTitle', { defaultValue: 'Send schedule emails?' })}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('overview.sendEmailsDescription', {
                      count: totalAssigned,
                      defaultValue: 'This will send an email to all {{count}} assigned players with their training schedule.',
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('overview.cancel', { defaultValue: 'Cancel' })}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleSendEmails}>
                    {t('overview.confirmSendEmails', { defaultValue: 'Send Emails' })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : pageStatus === 'notified' ? (
            <Badge variant="secondary" className="flex-1 flex items-center justify-center py-2">
              <CheckCheck className="h-4 w-4 mr-1" />
              {t('overview.allDone', { defaultValue: 'Done!' })}
            </Badge>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button className="flex-1" disabled={isProcessing || totalAssigned === 0}>
                  {pageStatus === 'booking' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCheck className="h-4 w-4 mr-1" />}
                  {t('proposals.approveAll', { defaultValue: 'Approve & Book all' })}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('overview.approveTitle', { defaultValue: 'Approve & book all?' })}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('overview.approveDescription', {
                      slots: totalSlots,
                      players: totalAssigned,
                      defaultValue: 'This will confirm all {{players}} player assignments across {{slots}} slots.',
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('overview.cancel', { defaultValue: 'Cancel' })}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleApproveAndBook}>
                    {t('overview.confirmApprove', { defaultValue: 'Approve & Book' })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Summary Card ---

function SummaryCard({
  icon: Icon,
  label,
  value,
  variant = 'default',
}: {
  icon: typeof Calendar;
  label: string;
  value: number;
  variant?: 'default' | 'warning';
}) {
  return (
    <div className={`rounded-lg border p-4 ${variant === 'warning' && value > 0 ? 'border-yellow-500/30 bg-yellow-500/5' : 'bg-card'}`}>
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <Icon className="h-4 w-4" />
        <span className="text-xs">{label}</span>
      </div>
      <p className={`text-2xl font-bold ${variant === 'warning' && value > 0 ? 'text-yellow-600' : ''}`}>
        {value}
      </p>
    </div>
  );
}
