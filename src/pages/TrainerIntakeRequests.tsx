import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { toast } from 'sonner';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { isTrainerSlotOverlapError } from '@/lib/slotConflicts';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { List, CalendarDays, AlertCircle, Download, UserPlus } from 'lucide-react';
import ProposalWorkflowSteps from '@/components/cycles/ProposalWorkflowSteps';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { TrainerPageHeader } from '@/components/trainer/shell/TrainerPageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { 
  generateProposals,
  resetProposals,
  resetSkippedRequests,
  movePlayerAssignment,
  moveSlot,
  swapSlots,
  deleteSlot,
  assignPlayerToSlot,
  unassignPlayer,
  exportIntakeRequestsToCsv,
  getAvailableSlotsForCycle,
  createProposalSlot,
  type SlotWithOccupancy,
} from '@/lib/cycles';
import IntakeRequestsTable from '@/components/cycles/IntakeRequestsTable';
import ProposalScheduleGrid from '@/components/cycles/ProposalScheduleGrid';
import IntakeRequestDetailSheet from '@/components/cycles/IntakeRequestDetailSheet';
import { GenerateProposalsWizard, type GenerateProposalsConfig } from '@/components/cycles/GenerateProposalsWizard';
import AddIntakeRequestDialog from '@/components/cycles/AddIntakeRequestDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { logger } from '@/lib/logger';
import {
  useCyclesQuery,
  useIntakeRequestsQuery,
  usePlayerLinksQuery,
  useInvalidateProposalData,
} from '@/hooks/useProposalData';
import { useQuery } from '@tanstack/react-query';

export default function TrainerIntakeRequests() {
  const { t } = useTranslation('cycles');
  const { user, loading } = useAuth();
  
  const [searchParams, setSearchParams] = useSearchParams();

  // Trainer profile query
  const { data: trainerId = null } = useQuery({
    queryKey: ['trainer-profile-id', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user.id)
        .single();
      return data?.id ?? null;
    },
    enabled: !!user,
    staleTime: Infinity,
  });

  // Persist UI state in URL
  const selectedCycleId = searchParams.get('cycle') || 'all';
  const statusFilter = searchParams.get('status') || 'all';
  const viewMode = searchParams.get('view') || 'list';

  const setStatusFilter = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value === 'all') params.delete('status'); else params.set('status', value);
    setSearchParams(params, { replace: true });
  };
  const setViewMode = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value === 'list') params.delete('view'); else params.set('view', value);
    setSearchParams(params, { replace: true });
  };

  // TanStack Query — cached
  const { data: cycles = [], isLoading: cyclesLoading } = useCyclesQuery('trainer', trainerId);
  const { data: requests = [] } = useIntakeRequestsQuery('trainer', trainerId);
  const cycleIds = useMemo(() => cycles.map(c => c.id), [cycles]);
  const { data: playerLinksData = [] } = usePlayerLinksQuery(cycleIds);

  const { invalidateAll, invalidateRequests } = useInvalidateProposalData();

  const isFirstLoad = loading || (cyclesLoading && cycles.length === 0);

  // Local schedule slots
  const [scheduleSlots, setScheduleSlots] = useState<SlotWithOccupancy[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<ReturnType<typeof requests.find> | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // Preserve selectedRequest
  useEffect(() => {
    setSelectedRequest(prev => {
      if (!prev) return null;
      return requests.find(r => r.id === prev.id) ?? null;
    });
  }, [requests]);

  // Load schedule slots — decoupled from requests
  useEffect(() => {
    if (viewMode === 'schedule' && selectedCycleId && selectedCycleId !== 'all') {
      getAvailableSlotsForCycle(selectedCycleId)
        .then(setScheduleSlots)
        .catch((err) => {
          logger.error('Failed to load schedule slots', err instanceof Error ? err : new Error(String(err)), { component: 'TrainerIntakeRequests', cycleId: selectedCycleId });
          setScheduleSlots([]);
        });
    } else {
      setScheduleSlots([]);
    }
  }, [viewMode, selectedCycleId]);

  // Auto-switch to schedule when filtering proposed
  useEffect(() => {
    if (statusFilter === 'proposed') {
      const cycleFiltered = selectedCycleId !== 'all'
        ? requests.filter(r => r.cycle_id === selectedCycleId)
        : requests;
      if (cycleFiltered.some(r => r.status === 'proposed')) {
        setViewMode('schedule');
      }
    }
  }, [statusFilter]);

  // Derived data
  const cycleFilteredRequests = selectedCycleId !== 'all' 
    ? requests.filter(r => r.cycle_id === selectedCycleId)
    : requests;

  const searchQuery = searchParams.get('q') || '';
  const setSearchQuery = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (!value) params.delete('q'); else params.set('q', value);
    setSearchParams(params, { replace: true });
  };

  const filteredRequests = useMemo(() => {
    let filtered = cycleFilteredRequests;
    if (statusFilter === 'skipped') {
      filtered = filtered.filter(r => r.status === 'new' && r.skip_reason);
    } else if (statusFilter !== 'all') {
      filtered = filtered.filter(r => r.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(r => (r.full_name || '').toLowerCase().includes(q));
    }
    return filtered;
  }, [cycleFilteredRequests, statusFilter, searchQuery]);

  const allCount = cycleFilteredRequests.length;
  const newCount = cycleFilteredRequests.filter(r => r.status === 'new' && !r.skip_reason).length;
  const skippedCount = cycleFilteredRequests.filter(r => r.status === 'new' && r.skip_reason).length;
  const proposedCount = cycleFilteredRequests.filter(r => r.status === 'proposed').length;
  const confirmedCount = cycleFilteredRequests.filter(r => r.status === 'confirmed').length;

  const unplacedPlayers = cycleFilteredRequests
    .filter(r => r.status === 'new' || r.status === 'rejected')
    .map(r => ({
      id: r.id, full_name: r.full_name, rating: r.rating, rating_system: r.rating_system,
      preferred_days: r.preferred_days, preferred_time_windows: r.preferred_time_windows,
      lesson_type: r.lesson_type, skip_reason: r.skip_reason, status: r.status,
      sessions_per_week: r.sessions_per_week,
    }));

  const allPlayersForGrid = cycleFilteredRequests
    .map(r => ({
      id: r.id, full_name: r.full_name, rating: r.rating, rating_system: r.rating_system,
      preferred_days: r.preferred_days, preferred_time_windows: r.preferred_time_windows,
      lesson_type: r.lesson_type, skip_reason: r.skip_reason, status: r.status,
      sessions_per_week: r.sessions_per_week,
    }));

  const skippedReasonCounts = statusFilter === 'skipped'
    ? filteredRequests.reduce((acc, r) => {
        const reason = r.skip_reason;
        if (reason) acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    : {};

  const selectedCycle = cycles.find(c => c.id === selectedCycleId);

  const refreshData = () => {
    if (trainerId) invalidateRequests('trainer', trainerId);
  };

  const handleGenerateProposals = async (config: GenerateProposalsConfig) => {
    if (selectedCycleId === 'all') {
      toast.error(t('proposals.selectCycleFirst', { defaultValue: 'Please select a specific cycle first' }));
      return;
    }
    setIsGenerating(true);
    try {
      const result = await generateProposals(selectedCycleId, config.weights, {
        startDate: config.startDate,
        trainerAvailability: config.trainerAvailability,
        additionalCriteria: config.additionalCriteria,
        timezone: config.timezone,
      });
      if (result.skipped > 0) {
        toast.success(
          t('proposals.generated', { count: result.generated }) + 
          ` · ${result.skipped} ${t('intakeRequests.filters.skipped', { defaultValue: 'skipped' }).toLowerCase()}`
        );
      } else {
        toast.success(t('proposals.generated', { count: result.generated }));
      }
      setShowWizard(false);
      if (trainerId) invalidateAll('trainer', trainerId, selectedCycleId);
    } catch (error: any) {
      toast.error(
                isTrainerSlotOverlapError(error)
                  ? t('slotConflict.trainerOverlap', { ns: 'common' })
                  : getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })),
              );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleResetProposals = async () => {
    if (selectedCycleId === 'all') {
      toast.error(t('proposals.selectCycleFirst', { defaultValue: 'Please select a specific cycle first' }));
      return;
    }
    setIsResetting(true);
    try {
      const result = await resetProposals(selectedCycleId);
      toast.success(t('proposals.resetSuccess', { count: result.reset, defaultValue: `Reset ${result.reset} proposals` }));
      setShowResetConfirm(false);
      if (trainerId) invalidateAll('trainer', trainerId, selectedCycleId);
    } catch (error: any) {
      toast.error(getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })));
    } finally {
      setIsResetting(false);
    }
  };

  if (isFirstLoad) {
    return (
      <div className="mx-auto w-full max-w-7xl py-2">
        <Skeleton className="h-8 w-48 mb-6" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 py-2">
      <TrainerPageHeader
        title={t('intakeRequests.title')}
        description={t('intakeRequests.subtitleShort', 'Review registrations and build proposals')}
        primaryAction={
          selectedCycleId !== 'all'
            ? {
                label: t('proposals.generate', { defaultValue: 'Generate proposals' }),
                onClick: () => setShowWizard(true),
              }
            : {
                label: t('intakeRequests.addManual', { defaultValue: 'Add registration' }),
                onClick: () => setShowAddDialog(true),
                icon: UserPlus,
              }
        }
        moreMenuItems={[
          {
            label: t('intakeRequests.addManual', { defaultValue: 'Add registration' }),
            onClick: () => setShowAddDialog(true),
            icon: UserPlus,
          },
          {
            label: t('intakeRequests.exportCsv', { defaultValue: 'Export CSV' }),
            onClick: () => {
              const cycleName = selectedCycle?.name ?? 'all';
              const date = format(new Date(), 'yyyy-MM-dd');
              const locMap: Record<string, string> = {};
              for (const c of cycles) {
                if (c.location_id && c.location?.name) locMap[c.location_id] = c.location.name;
              }
              exportIntakeRequestsToCsv(
                filteredRequests,
                `registrations-${cycleName}-${date}.csv`,
                undefined,
                playerLinksData,
                locMap,
              );
            },
            icon: Download,
          },
        ]}
      />

      {/* Workflow Steps */}
      <ProposalWorkflowSteps
        activeStep={proposedCount > 0 ? 'review-edit' : (selectedCycleId !== 'all' ? 'generate' : 'registrations')}
        onStepClick={() => {}}
        registrationsCount={allCount}
        pendingLinkActions={0}
        newCount={newCount}
        proposedCount={proposedCount}
        confirmedCount={confirmedCount}
      />

      {/* Status Filter Tabs + View Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <Tabs value={statusFilter} onValueChange={setStatusFilter}>
          <TabsList>
            <TabsTrigger value="all">
              {t('intakeRequests.filters.all')} ({allCount})
            </TabsTrigger>
            <TabsTrigger value="new">
              {t('intakeRequests.filters.new')} ({newCount})
            </TabsTrigger>
            {skippedCount > 0 && (
              <TabsTrigger value="skipped">
                {t('intakeRequests.filters.skipped')} ({skippedCount})
              </TabsTrigger>
            )}
            <TabsTrigger value="proposed">
              {t('intakeRequests.filters.proposed')} ({proposedCount})
            </TabsTrigger>
            <TabsTrigger value="confirmed">
              {t('intakeRequests.filters.confirmed')}
            </TabsTrigger>
            <TabsTrigger value="waitlist">
              {t('intakeRequests.filters.waitlist')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <ToggleGroup type="single" value={viewMode} onValueChange={(v) => v && setViewMode(v)} size="sm">
          <ToggleGroupItem value="list" aria-label="List view">
            <List className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="schedule" aria-label="Schedule view">
            <CalendarDays className="h-4 w-4" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Toolbar: search */}
      {viewMode === 'list' && (
        <TableToolbar
          searchPlaceholder={t('intakeRequests.searchPlaceholder', { defaultValue: 'Search by player name...' })}
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
        />
      )}

      {/* Skipped reasons summary */}
      {statusFilter === 'skipped' && Object.keys(skippedReasonCounts).length > 0 && (
        <Alert variant="default" className="border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning-soft))]/40">
          <AlertCircle className="h-4 w-4 text-[hsl(var(--warning))]" />
          <AlertDescription>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="font-medium mb-2">
                  {t('intakeRequests.skippedSummary', { count: filteredRequests.length })}
                </p>
                <ul className="space-y-1">
                  {Object.entries(skippedReasonCounts).map(([reason, count]) => (
                    <li key={reason} className="flex items-center justify-between text-sm max-w-sm">
                      <span>{t(`skipReasons.${reason}.title`)}</span>
                      <span className="text-muted-foreground font-medium">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={isResetting || selectedCycleId === 'all'}
                onClick={async () => {
                  if (selectedCycleId === 'all') {
                    toast.error(t('proposals.selectCycleFirst', { defaultValue: 'Please select a specific cycle first' }));
                    return;
                  }
                  setIsResetting(true);
                  try {
                    const result = await resetSkippedRequests(selectedCycleId);
                    toast.success(t('proposals.resetSkippedSuccess', { count: result.reset, defaultValue: `Reset ${result.reset} skipped registrations` }));
                    if (trainerId) invalidateAll('trainer', trainerId, selectedCycleId);
                    setStatusFilter('new');
                  } catch (error: any) {
                    toast.error(getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })));
                  } finally {
                    setIsResetting(false);
                  }
                }}
              >
                {isResetting ? t('proposals.resetting', { defaultValue: 'Resetting...' }) : t('proposals.resetSkipped', { defaultValue: 'Reset skipped' })}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Requests Table or Schedule Grid */}
      {viewMode === 'list' ? (
        filteredRequests.length === 0 ? (
          <Card className="overflow-hidden border-border/80 shadow-sm">
            <EmptyState variant="trainer"
              icon={List}
              title={t('intakeRequests.noRequests')}
              description={t('intakeRequests.noRequestsDescription')}
            />
          </Card>
        ) : (
          <IntakeRequestsTable
            requests={filteredRequests}
            onRowClick={setSelectedRequest}
            emptyMessage={t('intakeRequests.noRequests')}
            emptyDescription={t('intakeRequests.noRequestsDescription')}
            playerLinks={playerLinksData}
          />
        )
      ) : (
        <ProposalScheduleGrid
          slots={scheduleSlots}
          trainerAvailabilityWindows={selectedCycle?.settings?.trainer_availability_windows}
          onPlayerClick={(intakeRequestId) => {
            const req = requests.find(r => r.id === intakeRequestId);
            if (req) setSelectedRequest(req);
          }}
          onMovePlayer={async (assignmentId, newSlotId) => {
            const prev = [...scheduleSlots];
            setScheduleSlots(slots => {
              let assignment: any = null;
              const updated = slots.map(s => {
                const found = s.current_assignments.find((a: any) => a.id === assignmentId);
                if (found) {
                  assignment = found;
                  return { ...s, current_assignments: s.current_assignments.filter((a: any) => a.id !== assignmentId) };
                }
                return s;
              });
              if (!assignment) return slots;
              return updated.map(s => s.id === newSlotId ? { ...s, current_assignments: [...s.current_assignments, assignment] } : s);
            });
            try {
              await movePlayerAssignment(assignmentId, newSlotId);
              toast.success(t('proposals.playerMoved', 'Player moved successfully'));
            } catch (error: any) {
              setScheduleSlots(prev);
              toast.error(getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })));
            }
          }}
          onMoveSlot={async (slotId, newTrainerId, newStartTime, newEndTime) => {
            const prev = [...scheduleSlots];
            setScheduleSlots(slots => slots.map(s => s.id === slotId ? { ...s, trainer_id: newTrainerId, start_time: newStartTime, end_time: newEndTime } : s));
            try {
              await moveSlot(slotId, newTrainerId, newStartTime, newEndTime);
              toast.success(t('proposals.slotMoved', 'Slot moved successfully'));
            } catch (error: any) {
              setScheduleSlots(prev);
              toast.error(getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })));
            }
          }}
          onSwapSlots={async (slotAId, slotATrainer, slotAStart, slotAEnd, slotBId, slotBTrainer, slotBStart, slotBEnd) => {
            const prev = [...scheduleSlots];
            setScheduleSlots(slots => slots.map(s => {
              if (s.id === slotAId) return { ...s, trainer_id: slotATrainer, start_time: slotAStart, end_time: slotAEnd };
              if (s.id === slotBId) return { ...s, trainer_id: slotBTrainer, start_time: slotBStart, end_time: slotBEnd };
              return s;
            }));
            try {
              await swapSlots(slotAId, slotATrainer, slotAStart, slotAEnd, slotBId, slotBTrainer, slotBStart, slotBEnd);
              toast.success(t('proposals.slotsSwapped', 'Slots swapped successfully'));
            } catch (error: any) {
              setScheduleSlots(prev);
              toast.error(getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })));
            }
          }}
          onDeleteSlot={async (slotId) => {
            const prev = [...scheduleSlots];
            setScheduleSlots(slots => slots.filter(s => s.id !== slotId));
            try {
              await deleteSlot(slotId);
              toast.success(t('proposals.slotDeleted', { defaultValue: 'Slot deleted' }));
              refreshData();
            } catch (error: any) {
              setScheduleSlots(prev);
              toast.error(getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })));
            }
          }}
          onCreateSlot={async (trainerId, startTime, endTime) => {
            if (selectedCycleId === 'all') return;
            const tempId = `temp-${Date.now()}`;
            const newSlot: SlotWithOccupancy = {
              id: tempId,
              trainer_id: trainerId,
              start_time: startTime,
              end_time: endTime,
              max_participants: (selectedCycle?.settings as any)?.max_participants ?? 4,
              trainer_name: '',
              trainer_avatar: null,
              min_rating: null,
              max_rating: null,
              rating_system: null,
              cyclus_name: selectedCycle?.name ?? null,
              is_blocked: false,
              current_assignments: [],
            };
            setScheduleSlots(prev => [...prev, newSlot]);
            try {
              const result = await createProposalSlot(selectedCycleId, trainerId, startTime, endTime);
              setScheduleSlots(prev => prev.map(s => s.id === tempId ? { ...s, id: result.id } : s));
              toast.success(t('proposals.slotCreated', { defaultValue: 'Slot created' }));
            } catch (error: any) {
              setScheduleSlots(prev => prev.filter(s => s.id !== tempId));
              toast.error(getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })));
            }
          }}
          onUndo={(previousSlots) => {
            setScheduleSlots(previousSlots);
            toast.info(t('proposals.undone', { defaultValue: 'Change undone — save or continue editing' }));
          }}
          unplacedPlayers={unplacedPlayers}
          allPlayers={allPlayersForGrid}
          onAssignPlayer={async (intakeRequestId, slotId) => {
            const prev = [...scheduleSlots];
            const player = requests.find(r => r.id === intakeRequestId);
            setScheduleSlots(slots => slots.map(s => s.id === slotId ? {
              ...s,
              current_assignments: [...s.current_assignments, {
                id: `temp-${Date.now()}`,
                intake_request_id: intakeRequestId,
                player_name: player?.full_name || '',
                player_rating: player?.rating ?? null,
                player_rating_system: player?.rating_system ?? null,
                confidence_score: null,
                sessions_per_week: player?.sessions_per_week ?? 1,
              }]
            } : s));
            try {
              await assignPlayerToSlot(intakeRequestId, slotId);
              toast.success(t('proposals.playerAssigned', { defaultValue: 'Player assigned to slot' }));
              if (selectedCycleId && selectedCycleId !== 'all') {
                const updatedSlots = await getAvailableSlotsForCycle(selectedCycleId);
                setScheduleSlots(updatedSlots);
              }
              refreshData();
            } catch (error: any) {
              setScheduleSlots(prev);
              toast.error(getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })));
            }
          }}
          onUnassignPlayer={async (assignmentId) => {
            const prev = [...scheduleSlots];
            setScheduleSlots(slots => slots.map(s => ({
              ...s,
              current_assignments: s.current_assignments.filter((a: any) => a.id !== assignmentId),
            })));
            try {
              await unassignPlayer(assignmentId);
              toast.success(t('proposals.playerUnassigned', { defaultValue: 'Player returned to unplaced pool' }));
              refreshData();
            } catch (error: any) {
              setScheduleSlots(prev);
              toast.error(getFriendlyErrorMessage(error, t('proposals.genericError', { defaultValue: 'Something went wrong. Please try again.' })));
            }
          }}
        />
      )}

      {/* Detail Sheet */}
      <IntakeRequestDetailSheet
        request={selectedRequest}
        open={!!selectedRequest}
        onOpenChange={(open) => !open && setSelectedRequest(null)}
        onStatusChange={refreshData}
        cycleId={selectedCycle?.id}
        playerLinks={playerLinksData}
        allRequests={requests}
        onLinkChanged={refreshData}
      />

      {/* Generate Proposals Wizard */}
      {selectedCycle && trainerId && (
        <GenerateProposalsWizard
          open={showWizard}
          onOpenChange={setShowWizard}
          cycle={selectedCycle}
          onGenerate={handleGenerateProposals}
          isGenerating={isGenerating}
          ownerType="trainer"
          ownerId={trainerId}
        />
      )}

      {/* Add Registration Dialog */}
      <AddIntakeRequestDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        cycleId={selectedCycleId !== 'all' ? selectedCycleId : undefined}
        cycles={cycles}
        onSuccess={() => {
          setShowAddDialog(false);
          if (trainerId) invalidateAll('trainer', trainerId);
        }}
      />

      {/* Reset Proposals Confirmation */}
      <ConfirmDialog
        open={showResetConfirm}
        onOpenChange={setShowResetConfirm}
        title={t('proposals.resetTitle', { defaultValue: 'Reset all proposals?' })}
        description={t('proposals.resetDescription', { defaultValue: 'This will remove all generated proposals and set the registrations back to "new". You can then regenerate proposals with different settings.' })}
        confirmLabel={t('proposals.resetConfirm', { defaultValue: 'Reset proposals' })}
        cancelLabel={t('common:cancel', { defaultValue: 'Cancel' })}
        loading={isResetting}
        onConfirm={handleResetProposals}
      />
    </div>
  );
}
