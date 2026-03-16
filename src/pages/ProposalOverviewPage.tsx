import { useMemo, useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
  ArrowLeft,
  CheckCheck,
  Calendar,
  Users,
  AlertTriangle,
  Clock,
  UserX,
  ScaleIcon,
  Loader2,
} from 'lucide-react';
import { getAvailableSlotsForCycle, type SlotWithOccupancy } from '@/lib/cycles';

// --- Helpers ---

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(dateStr: string, locale: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short' });
}

function getDateKey(dateStr: string) {
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

// --- Component ---

export default function ProposalOverviewPage() {
  const { t, i18n } = useTranslation('cycles');
  const location = useLocation();
  const navigate = useNavigate();

  const stateSlots: SlotWithOccupancy[] = (location.state as any)?.slots ?? [];
  const cycleId: string | undefined = (location.state as any)?.cycleId;
  const backPath: string = (location.state as any)?.backPath ?? -1;

  const [fetchedSlots, setFetchedSlots] = useState<SlotWithOccupancy[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // If no slots were passed via state, fetch them using cycleId
  useEffect(() => {
    if (stateSlots.length === 0 && cycleId) {
      setIsLoading(true);
      getAvailableSlotsForCycle(cycleId)
        .then(setFetchedSlots)
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [cycleId]); // eslint-disable-line react-hooks/exhaustive-deps

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

      const dateKey = getDateKey(slot.start_time);
      let day = group.days.get(dateKey);
      if (!day) {
        day = { label: formatDayLabel(slot.start_time, i18n.language), slots: [] };
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

    const sorted = Array.from(groupMap.values()).sort((a, b) => a.trainerName.localeCompare(b.trainerName));
    const totalSlots = cycleSlots.length;
    const totalAssigned = cycleSlots.reduce((sum, s) => sum + s.current_assignments.length, 0);
    const totalEmpty = cycleSlots.filter(s => s.current_assignments.length === 0).length;

    // Build warnings
    const warnings: Warning[] = [];

    // 1. Empty slots
    if (totalEmpty > 0) {
      warnings.push({
        type: 'empty',
        icon: Clock,
        message: t('overview.warningEmpty', {
          count: totalEmpty,
          defaultValue: '{{count}} slots have no players assigned',
        }),
      });
    }

    // 2. Solo players (groups with only 1 player)
    const soloCount = cycleSlots.filter(s => s.current_assignments.length === 1).length;
    if (soloCount > 0) {
      warnings.push({
        type: 'solo',
        icon: UserX,
        message: t('overview.warningSolo', {
          count: soloCount,
          defaultValue: '{{count}} slots have only 1 player (group training needs 2+)',
        }),
      });
    }

    // 3. Large rating gaps (> 2 rating points within a slot)
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
        message: t('overview.warningRatingGap', {
          count: ratingGapCount,
          defaultValue: '{{count}} slots have a rating gap larger than 2 points',
        }),
      });
    }

    // 4. Trainer workload imbalance (>2x difference)
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

  const handleBack = () => {
    if (typeof backPath === 'string') {
      navigate(backPath);
    } else {
      navigate(-1);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6 flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

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
        <Button onClick={() => {}} className="hidden sm:flex">
          <CheckCheck className="h-4 w-4 mr-1" />
          {t('proposals.approveAll', { defaultValue: 'Approve & Book all' })}
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard
          icon={Calendar}
          label={t('overview.totalSlots', { defaultValue: 'Total slots' })}
          value={totalSlots}
        />
        <SummaryCard
          icon={Users}
          label={t('overview.playersAssigned', { defaultValue: 'Players assigned' })}
          value={totalAssigned}
        />
        <SummaryCard
          icon={Clock}
          label={t('overview.emptySlots', { defaultValue: 'Empty slots' })}
          value={totalEmpty}
          variant={totalEmpty > 0 ? 'warning' : 'default'}
        />
        <SummaryCard
          icon={Users}
          label={t('overview.trainers', { defaultValue: 'Trainers' })}
          value={trainerGroups.length}
        />
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
                                    {formatTime(slot.start_time)} – {formatTime(slot.end_time)}
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
          <Button className="flex-1" onClick={() => {}}>
            <CheckCheck className="h-4 w-4 mr-1" />
            {t('proposals.approveAll', { defaultValue: 'Approve & Book all' })}
          </Button>
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
