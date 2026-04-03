import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ArrowLeft, List, CalendarDays, AlertCircle, Download } from 'lucide-react';
import ProposalWorkflowSteps from '@/components/cycles/ProposalWorkflowSteps';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  getCycles, 
  getIntakeRequestsWithProposals, 
  getAvailableSlotsForCycle,
  generateProposals,
  resetProposals,
  movePlayerAssignment,
  moveSlot,
  swapSlots,
  deleteSlot,
  assignPlayerToSlot,
  unassignPlayer,
  exportIntakeRequestsToCsv,
  getPlayerLinks,
  type Cycle, 
  type IntakeRequestWithProposal,
  type SlotWithOccupancy,
  type PlayerLink,
} from '@/lib/cycles';
import IntakeRequestsTable from '@/components/cycles/IntakeRequestsTable';
import ProposalScheduleGrid from '@/components/cycles/ProposalScheduleGrid';
import IntakeRequestDetailSheet from '@/components/cycles/IntakeRequestDetailSheet';
import { GenerateProposalsWizard, type GenerateProposalsConfig } from '@/components/cycles/GenerateProposalsWizard';
import AddIntakeRequestDialog from '@/components/cycles/AddIntakeRequestDialog';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { logger } from '@/lib/logger';

export default function TrainerIntakeRequests() {
  const { t } = useTranslation('cycles');
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [requests, setRequests] = useState<IntakeRequestWithProposal[]>([]);
  const [filteredRequests, setFilteredRequests] = useState<IntakeRequestWithProposal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [selectedCycleId, setSelectedCycleId] = useState<string>(searchParams.get('cycle') || 'all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedRequest, setSelectedRequest] = useState<IntakeRequestWithProposal | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [viewMode, setViewMode] = useState<string>('list');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [scheduleSlots, setScheduleSlots] = useState<SlotWithOccupancy[]>([]);
  const [playerLinksData, setPlayerLinksData] = useState<PlayerLink[]>([]);
  

  useEffect(() => {
    const fetchTrainerId = async () => {
      if (!user) return;
      const { data } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user.id)
        .single();
      if (data) setTrainerId(data.id);
    };
    if (user) fetchTrainerId();
  }, [user]);

  const fetchData = async () => {
    if (!trainerId) return;

    setIsLoading(true);
    try {
      const [cyclesData, requestsData] = await Promise.all([
        getCycles('trainer', trainerId),
        getIntakeRequestsWithProposals('trainer', trainerId)
      ]);
      setCycles(cyclesData);
      setRequests(requestsData);

      // Preserve selectedRequest identity across refresh
      setSelectedRequest(prev => {
        if (!prev) return null;
        return requestsData.find(r => r.id === prev.id) ?? null;
      });

      const allLinks: PlayerLink[] = [];
      for (const c of cyclesData) {
        const links = await getPlayerLinks(c.id);
        allLinks.push(...links);
      }
      setPlayerLinksData(allLinks);
    } catch (error: any) {
      logger.error('Error fetching intake requests', error as Error, { component: 'TrainerIntakeRequests', trainerId });
      toast.error(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Silent refresh: same as fetchData but without loading skeleton
  const refreshData = async () => {
    if (!trainerId) return;
    try {
      const [cyclesData, requestsData] = await Promise.all([
        getCycles('trainer', trainerId),
        getIntakeRequestsWithProposals('trainer', trainerId)
      ]);
      setCycles(cyclesData);
      setRequests(requestsData);
      setSelectedRequest(prev => {
        if (!prev) return null;
        return requestsData.find(r => r.id === prev.id) ?? null;
      });
      const allLinks: PlayerLink[] = [];
      for (const c of cyclesData) {
        const links = await getPlayerLinks(c.id);
        allLinks.push(...links);
      }
      setPlayerLinksData(allLinks);
    } catch (error: any) {
      logger.error('Error refreshing intake requests', error as Error, { component: 'TrainerIntakeRequests', trainerId });
    }
  };

  useEffect(() => {
    if (trainerId) fetchData();
  }, [trainerId]);

  useEffect(() => {
    let filtered = requests;
    if (selectedCycleId !== 'all') {
      filtered = filtered.filter(r => r.cycle_id === selectedCycleId);
    }
    if (statusFilter === 'skipped') {
      filtered = filtered.filter(r => r.status === 'new' && r.skip_reason);
    } else if (statusFilter !== 'all') {
      filtered = filtered.filter(r => r.status === statusFilter);
    }
    setFilteredRequests(filtered);
  }, [requests, selectedCycleId, statusFilter]);

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
  }, [viewMode, selectedCycleId, requests]);

  useEffect(() => {
    if (statusFilter === 'proposed' && filteredRequests.some(r => r.status === 'proposed')) {
      setViewMode('schedule');
    }
  }, [statusFilter, filteredRequests]);

  const handleCycleChange = (value: string) => {
    setSelectedCycleId(value);
    if (value === 'all') {
      searchParams.delete('cycle');
    } else {
      searchParams.set('cycle', value);
    }
    setSearchParams(searchParams);
  };

  const handleGenerateProposals = async (config: GenerateProposalsConfig) => {
    if (selectedCycleId === 'all') {
      toast.error('Please select a specific cycle first');
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
      fetchData();
    } catch (error: any) {
      toast.error(error.message);
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
      fetchData();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsResetting(false);
    }
  };

  const selectedCycle = cycles.find(c => c.id === selectedCycleId);

  // All counts derived from cycle-filtered requests (before status filter)
  const cycleFilteredRequests = selectedCycleId !== 'all' 
    ? requests.filter(r => r.cycle_id === selectedCycleId)
    : requests;
  const allCount = cycleFilteredRequests.length;
  const newCount = cycleFilteredRequests.filter(r => r.status === 'new' && !r.skip_reason).length;
  const skippedCount = cycleFilteredRequests.filter(r => r.status === 'new' && r.skip_reason).length;
  const proposedCount = cycleFilteredRequests.filter(r => r.status === 'proposed').length;
  const confirmedCount = cycleFilteredRequests.filter(r => r.status === 'confirmed').length;

  // Unplaced players for the sidebar (status 'new' for selected cycle)
  const unplacedPlayers = cycleFilteredRequests
    .filter(r => r.status === 'new')
    .map(r => ({
      id: r.id,
      full_name: r.full_name,
      rating: r.rating,
      rating_system: r.rating_system,
      preferred_days: r.preferred_days,
      lesson_type: r.lesson_type,
      skip_reason: r.skip_reason,
      sessions_per_week: r.sessions_per_week,
    }));

  const allPlayersForGrid = cycleFilteredRequests
    .map(r => ({
      id: r.id,
      full_name: r.full_name,
      rating: r.rating,
      rating_system: r.rating_system,
      preferred_days: r.preferred_days,
      lesson_type: r.lesson_type,
      skip_reason: r.skip_reason,
      sessions_per_week: r.sessions_per_week,
    }));

  const skippedReasonCounts = statusFilter === 'skipped'
    ? filteredRequests.reduce((acc, r) => {
        const reason = r.skip_reason;
        if (reason) acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    : {};

  if (loading || isLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Skeleton className="h-8 w-48 mb-6" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/app/trainer/cycles')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{t('intakeRequests.title')}</h1>
            <p className="text-muted-foreground hidden sm:block">
              {t('intakeRequests.noRequestsDescription')}
            </p>
          </div>
        </div>
      </div>

      {/* Workflow Steps (always visible, includes cycle selector as step 1) */}
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

        <div className="flex items-center gap-2">
          <ToggleGroup type="single" value={viewMode} onValueChange={(v) => v && setViewMode(v)} size="sm">
            <ToggleGroupItem value="list" aria-label="List view">
              <List className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="schedule" aria-label="Schedule view">
              <CalendarDays className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const cycleName = selectedCycle?.name ?? 'all';
              const date = format(new Date(), 'yyyy-MM-dd');
              const locMap: Record<string, string> = {};
              for (const c of cycles) {
                if (c.location_id && c.location?.name) locMap[c.location_id] = c.location.name;
              }
              exportIntakeRequestsToCsv(filteredRequests, `registrations-${cycleName}-${date}.csv`, undefined, playerLinksData, locMap);
            }}
            disabled={filteredRequests.length === 0}
            className="h-8 text-xs"
          >
            <Download className="h-3 w-3 mr-1" />
            CSV
          </Button>
        </div>
      </div>

      {/* Skipped reasons summary */}
      {statusFilter === 'skipped' && Object.keys(skippedReasonCounts).length > 0 && (
        <Alert variant="default" className="bg-yellow-500/5 border-yellow-500/30">
          <AlertCircle className="h-4 w-4 text-yellow-600" />
          <AlertDescription>
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
          </AlertDescription>
        </Alert>
      )}

      {/* Requests Table or Schedule Grid */}
      {viewMode === 'list' ? (
        <IntakeRequestsTable
          requests={filteredRequests}
          onRowClick={setSelectedRequest}
          emptyMessage={t('intakeRequests.noRequests')}
          emptyDescription={t('intakeRequests.noRequestsDescription')}
          playerLinks={playerLinksData}
        />
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
              toast.error(error.message);
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
              toast.error(error.message);
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
              toast.error(error.message);
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
              toast.error(error.message);
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
              toast.error(error.message);
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
              toast.error(error.message);
            }
          }}
        />
      )}

      {/* Detail Sheet */}
      <IntakeRequestDetailSheet
        request={selectedRequest}
        open={!!selectedRequest}
        onOpenChange={(open) => !open && setSelectedRequest(null)}
        onStatusChange={fetchData}
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
          fetchData();
        }}
      />


      {/* Reset Proposals Confirmation */}
      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('proposals.resetTitle', { defaultValue: 'Reset all proposals?' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('proposals.resetDescription', { defaultValue: 'This will remove all generated proposals and set the registrations back to "new". You can then regenerate proposals with different settings.' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>{t('common:cancel', { defaultValue: 'Cancel' })}</AlertDialogCancel>
            <Button onClick={handleResetProposals} disabled={isResetting} variant="destructive">
              {isResetting ? t('proposals.resetting', { defaultValue: 'Resetting...' }) : t('proposals.resetConfirm', { defaultValue: 'Reset proposals' })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
