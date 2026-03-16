import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { CheckCheck, ArrowLeft, Users, Calendar, Clock } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { SlotWithOccupancy } from '@/lib/cycles';

interface ProposalOverviewPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slots: SlotWithOccupancy[];
  onApproveAll: () => void;
  onBackToEditing: () => void;
  isApproving?: boolean;
}

interface TrainerGroup {
  trainerId: string;
  trainerName: string;
  trainerAvatar: string | null;
  days: Map<string, DayGroup>;
  totalSlots: number;
  totalPlayers: number;
}

interface DayGroup {
  label: string;
  slots: SlotWithOccupancy[];
}

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

export default function ProposalOverviewPanel({
  open,
  onOpenChange,
  slots,
  onApproveAll,
  onBackToEditing,
  isApproving,
}: ProposalOverviewPanelProps) {
  const { t, i18n } = useTranslation('cycles');

  const cycleSlots = useMemo(() => slots.filter(s => !s.is_blocked), [slots]);

  const { trainerGroups, totalSlots, totalAssigned, totalUnassigned } = useMemo(() => {
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

    const totalSlots = cycleSlots.length;
    const totalAssigned = cycleSlots.reduce((sum, s) => sum + s.current_assignments.length, 0);
    const emptySlots = cycleSlots.filter(s => s.current_assignments.length === 0).length;

    return {
      trainerGroups: Array.from(groupMap.values()).sort((a, b) => a.trainerName.localeCompare(b.trainerName)),
      totalSlots,
      totalAssigned,
      totalUnassigned: emptySlots,
    };
  }, [cycleSlots, i18n.language]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-lg">
            {t('workflow.overviewTitle', { defaultValue: 'Overview — Approve & Book' })}
          </DialogTitle>
        </DialogHeader>

        {/* Summary stats */}
        <div className="flex gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{totalSlots}</span>
            <span className="text-muted-foreground">{t('workflow.overviewSlots', { defaultValue: 'slots' })}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{totalAssigned}</span>
            <span className="text-muted-foreground">{t('workflow.overviewAssigned', { defaultValue: 'players assigned' })}</span>
          </div>
          {totalUnassigned > 0 && (
            <div className="flex items-center gap-2 text-sm text-orange-600">
              <Clock className="h-4 w-4" />
              <span className="font-medium">{totalUnassigned}</span>
              <span>{t('workflow.overviewEmpty', { defaultValue: 'empty slots' })}</span>
            </div>
          )}
        </div>

        {/* Per-trainer breakdown */}
        <div className="flex-1 overflow-y-auto space-y-5 pr-1">
          {trainerGroups.map((group) => (
            <div key={group.trainerId} className="space-y-2">
              {/* Trainer header */}
              <div className="flex items-center gap-2 sticky top-0 bg-background py-1">
                <Avatar className="h-6 w-6">
                  <AvatarImage src={group.trainerAvatar || undefined} />
                  <AvatarFallback className="text-xs">
                    {group.trainerName.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="font-semibold text-sm">{group.trainerName}</span>
                <Badge variant="secondary" className="text-xs">
                  {group.totalSlots} {t('workflow.overviewSlots', { defaultValue: 'slots' })} · {group.totalPlayers} {t('workflow.overviewPlayers', { defaultValue: 'players' })}
                </Badge>
              </div>

              {/* Days */}
              {Array.from(group.days.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([dateKey, day]) => (
                <div key={dateKey} className="ml-8 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground capitalize">{day.label}</p>
                  <div className="space-y-0.5">
                    {day.slots.map((slot) => (
                      <div key={slot.id} className="flex items-center gap-3 text-sm py-0.5 pl-2 border-l-2 border-primary/20">
                        <span className="text-muted-foreground tabular-nums w-[90px] flex-shrink-0">
                          {formatTime(slot.start_time)} – {formatTime(slot.end_time)}
                        </span>
                        <div className="flex flex-wrap gap-1 min-w-0">
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
                              {t('workflow.overviewNoPlayers', { defaultValue: 'No players assigned' })}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {trainerGroups.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t('workflow.overviewNoData', { defaultValue: 'No proposals to show.' })}
            </p>
          )}
        </div>

        <DialogFooter className="flex-row gap-2 sm:justify-between">
          <Button variant="outline" onClick={onBackToEditing}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t('workflow.backToEditing', { defaultValue: 'Back to editing' })}
          </Button>
          <Button onClick={onApproveAll} disabled={isApproving || totalSlots === 0}>
            <CheckCheck className="h-4 w-4 mr-1" />
            {t('proposals.approveAll', { defaultValue: 'Approve & Book all' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
