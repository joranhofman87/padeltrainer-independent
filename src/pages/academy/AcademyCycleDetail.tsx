import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  ExternalLink,
  Copy,
  MoreHorizontal,
  ToggleLeft,
  ToggleRight,
  List,
  CalendarDays,
  AlertCircle,
  UserPlus,
  Download,
  Settings,
  Sparkles,
  RotateCcw,
  Eye,
  Clock,
} from 'lucide-react';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getMarketingUrl } from '@/lib/domains';
import {
  getCycle,
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
  updateCycle,
  type Cycle,
  type IntakeRequestWithProposal,
  type SlotWithOccupancy,
  type PlayerLink,
} from '@/lib/cycles';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import { supabase } from '@/lib/supabaseClient';
import IntakeRequestsTable from '@/components/cycles/IntakeRequestsTable';
import ProposalScheduleGrid from '@/components/cycles/ProposalScheduleGrid';
import IntakeRequestDetailSheet from '@/components/cycles/IntakeRequestDetailSheet';
import { GenerateProposalsWizard, type GenerateProposalsConfig } from '@/components/cycles/GenerateProposalsWizard';
import ProposalWorkflowSteps, { type WorkflowStep } from '@/components/cycles/ProposalWorkflowSteps';
import AddIntakeRequestDialog from '@/components/cycles/AddIntakeRequestDialog';
import CycleForm from '@/components/cycles/CycleForm';
import WaitingListTable from '@/components/waitingList/WaitingListTable';
import PreGenerationReview from '@/components/cycles/PreGenerationReview';
import { getSuggestedLinks, getLinkedIdsForRequest, getDismissedSuggestions, getUnmatchedMentions, getDismissedUnmatched } from '@/lib/suggestLinks';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { logger } from '@/lib/logger';

export default function AcademyCycleDetail() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const { t, i18n } = useTranslation('cycles');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();
  const locale = i18n.language === 'nl' ? nl : enUS;

  // Active step from URL
  const rawStep = searchParams.get('step') || 'registrations';
  const activeStep: WorkflowStep = (['registrations', 'review-links', 'generate', 'review-edit', 'approve'].includes(rawStep) ? rawStep : 'registrations') as WorkflowStep;
  const isWaitingList = rawStep === 'waitinglist';
  const setActiveStep = (step: string) => {
    setSearchParams({ step }, { replace: true });
  };

  // Data state
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [requests, setRequests] = useState<IntakeRequestWithProposal[]>([]);
  const [filteredRequests, setFilteredRequests] = useState<IntakeRequestWithProposal[]>([]);
  const [playerLinksData, setPlayerLinksData] = useState<PlayerLink[]>([]);
  const [scheduleSlots, setScheduleSlots] = useState<SlotWithOccupancy[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedRequest, setSelectedRequest] = useState<IntakeRequestWithProposal | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<string>('list');
  const [showWizard, setShowWizard] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Settings data
  const [trainers, setTrainers] = useState<{ id: string; name: string; hourly_rate?: number }[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string; city: string }[]>([]);
  const [trainerLocationMap, setTrainerLocationMap] = useState<Record<string, string[]>>({});

  const fetchCycle = useCallback(async () => {
    if (!cycleId) return;
    const data = await getCycle(cycleId);
    setCycle(data);
    return data;
  }, [cycleId]);

  const fetchRequests = useCallback(async () => {
    if (!activeAcademy || !cycleId) return;
    const requestsData = await getIntakeRequestsWithProposals('academy', activeAcademy.id);
    const cycleRequests = requestsData.filter(r => r.cycle_id === cycleId);
    setRequests(cycleRequests);
    setSelectedRequest(prev => {
      if (!prev) return null;
      return cycleRequests.find(r => r.id === prev.id) ?? null;
    });
    const links = await getPlayerLinks(cycleId);
    setPlayerLinksData(links);
  }, [activeAcademy, cycleId]);

  const fetchSettingsData = useCallback(async () => {
    if (!activeAcademy) return;
    const [academyTrainers, academyLocations] = await Promise.all([
      getAcademyTrainersWithProfiles(activeAcademy.id),
      getAcademyLocations(activeAcademy.id),
    ]);

    const trainerIds = academyTrainers.map(t => t.trainer_profile_id);
    let tlMap: Record<string, string[]> = {};
    if (trainerIds.length > 0) {
      const { data: trainerLocs } = await supabase
        .from('trainer_locations')
        .select('trainer_id, location_id')
        .in('trainer_id', trainerIds);
      if (trainerLocs) {
        for (const tl of trainerLocs) {
          if (!tlMap[tl.location_id]) tlMap[tl.location_id] = [];
          tlMap[tl.location_id].push(tl.trainer_id);
        }
      }
    }
    setTrainerLocationMap(tlMap);
    setTrainers(
      academyTrainers.map((t) => ({
        id: t.trainer_profile_id,
        name: t.profile?.full_name || 'Unknown',
        hourly_rate: t.trainer_profile?.hourly_rate || undefined,
      }))
    );
    setLocations(
      academyLocations
        .filter((l) => l.location)
        .map((l) => ({
          id: l.location!.id,
          name: l.location!.name,
          city: l.location!.city || '',
        }))
    );
  }, [activeAcademy]);

  // Initial load
  useEffect(() => {
    const load = async () => {
      if (!activeAcademy || !cycleId) return;
      setIsLoading(true);
      try {
        await Promise.all([fetchCycle(), fetchRequests(), fetchSettingsData()]);
      } catch (error: any) {
        logger.error('Error loading cycle detail', error as Error, { component: 'AcademyCycleDetail' });
        toast.error(error.message);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [activeAcademy, cycleId]);

  // Silent refresh
  const refreshData = useCallback(async () => {
    try {
      await Promise.all([fetchCycle(), fetchRequests()]);
    } catch (error: any) {
      logger.error('Error refreshing cycle detail', error as Error, { component: 'AcademyCycleDetail' });
    }
  }, [fetchCycle, fetchRequests]);

  // Filter requests by status
  useEffect(() => {
    let filtered = requests;
    if (statusFilter === 'skipped') {
      filtered = filtered.filter(r => r.status === 'new' && r.skip_reason);
    } else if (statusFilter !== 'all') {
      filtered = filtered.filter(r => r.status === statusFilter);
    }
    setFilteredRequests(filtered);
  }, [requests, statusFilter]);

  // Load schedule slots when needed
  useEffect(() => {
    if ((viewMode === 'schedule' || activeStep === 'review-edit' || activeStep === 'approve') && cycleId) {
      getAvailableSlotsForCycle(cycleId)
        .then(setScheduleSlots)
        .catch(() => setScheduleSlots([]));
    } else {
      setScheduleSlots([]);
    }
  }, [viewMode, activeStep, cycleId, requests]);

  // Counts
  const allCount = requests.length;
  const newCount = requests.filter(r => r.status === 'new' && !r.skip_reason).length;
  const skippedCount = requests.filter(r => r.status === 'new' && r.skip_reason).length;
  const proposedCount = requests.filter(r => r.status === 'proposed').length;
  const confirmedCount = requests.filter(r => r.status === 'confirmed').length;

  // Pending link actions
  const pendingLinkActions = useMemo(() => {
    const dismissed = getDismissedSuggestions();
    const dismissedUn = getDismissedUnmatched();
    const seenPairs = new Set<string>();
    let count = 0;
    for (const req of requests) {
      const linkedIds = new Set(getLinkedIdsForRequest(req.id, playerLinksData));
      const matches = getSuggestedLinks(req, requests, linkedIds, dismissed);
      for (const match of matches) {
        const pairKey = [req.id, match.id].sort().join('::');
        if (!seenPairs.has(pairKey)) { seenPairs.add(pairKey); count++; }
      }
      // Unmatched mentions are info-only, not counted as pending actions
    }
    return count;
  }, [requests, playerLinksData]);

  const unplacedPlayers = requests
    .filter(r => r.status === 'new')
    .map(r => ({
      id: r.id,
      full_name: r.full_name,
      rating: r.rating,
      rating_system: r.rating_system,
      preferred_days: r.preferred_days,
      lesson_type: r.lesson_type,
      skip_reason: r.skip_reason,
    }));

  const skippedReasonCounts = statusFilter === 'skipped'
    ? filteredRequests.reduce((acc, r) => {
        const reason = r.skip_reason;
        if (reason) acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    : {};

  const handleGenerateProposals = async (config: GenerateProposalsConfig) => {
    if (!cycleId) return;
    setIsGenerating(true);
    try {
      const result = await generateProposals(cycleId, config.weights, {
        startDate: config.startDate,
        trainerAvailability: config.trainerAvailability,
        additionalCriteria: config.additionalCriteria,
        keepCompleteGroups: config.keepCompleteGroups,
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
      setActiveStep('review-edit');
      refreshData();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleResetProposals = async () => {
    if (!cycleId) return;
    setIsResetting(true);
    try {
      const result = await resetProposals(cycleId);
      toast.success(t('proposals.resetSuccess', { count: result.reset, defaultValue: `Reset ${result.reset} proposals` }));
      setShowResetConfirm(false);
      setActiveStep('generate');
      refreshData();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsResetting(false);
    }
  };

  const handleCopyLink = () => {
    if (!cycle || !activeAcademy) return;
    const lang = i18n.language || 'nl';
    const path = activeAcademy.slug
      ? `academies/${activeAcademy.slug}/register/${cycle.id}`
      : `register/${cycle.id}`;
    const url = getMarketingUrl(path, lang);
    navigator.clipboard.writeText(url);
    toast.success(t('actions.linkCopied'));
  };

  const handleToggleStatus = async () => {
    if (!cycle) return;
    const newStatus = cycle.status === 'open' ? 'closed' : 'open';
    try {
      await updateCycle(cycle.id, { status: newStatus });
      toast.success(t(`status.${newStatus}`));
      fetchCycle();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      draft: 'bg-muted text-muted-foreground',
      open: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
      closed: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
      archived: 'bg-muted text-muted-foreground',
    };
    return (
      <Badge variant="outline" className={colors[status]}>
        {t(`status.${status}`)}
      </Badge>
    );
  };

  // Schedule grid event handlers (shared between steps)
  const scheduleGridHandlers = {
    onPlayerClick: (intakeRequestId: string) => {
      const req = requests.find(r => r.id === intakeRequestId);
      if (req) setSelectedRequest(req);
    },
    onMovePlayer: async (assignmentId: string, newSlotId: string) => {
      try {
        await movePlayerAssignment(assignmentId, newSlotId);
        toast.success(t('proposals.playerMoved', 'Player moved successfully'));
        const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
        setScheduleSlots(updatedSlots);
      } catch (error: any) {
        toast.error(error.message);
      }
    },
    onMoveSlot: async (slotId: string, newTrainerId: string, newStartTime: string, newEndTime: string) => {
      try {
        await moveSlot(slotId, newTrainerId, newStartTime, newEndTime);
        toast.success(t('proposals.slotMoved', 'Slot moved successfully'));
        const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
        setScheduleSlots(updatedSlots);
      } catch (error: any) {
        toast.error(error.message);
      }
    },
    onSwapSlots: async (slotAId: string, slotATrainer: string, slotAStart: string, slotAEnd: string, slotBId: string, slotBTrainer: string, slotBStart: string, slotBEnd: string) => {
      try {
        await swapSlots(slotAId, slotATrainer, slotAStart, slotAEnd, slotBId, slotBTrainer, slotBStart, slotBEnd);
        toast.success(t('proposals.slotsSwapped', 'Slots swapped successfully'));
        const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
        setScheduleSlots(updatedSlots);
      } catch (error: any) {
        toast.error(error.message);
      }
    },
    onDeleteSlot: async (slotId: string) => {
      try {
        await deleteSlot(slotId);
        toast.success(t('proposals.slotDeleted', { defaultValue: 'Slot deleted' }));
        const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
        setScheduleSlots(updatedSlots);
        refreshData();
      } catch (error: any) {
        toast.error(error.message);
      }
    },
    onUndo: (previousSlots: SlotWithOccupancy[]) => {
      setScheduleSlots(previousSlots);
      toast.info(t('proposals.undone', { defaultValue: 'Change undone — save or continue editing' }));
    },
    onAssignPlayer: async (intakeRequestId: string, slotId: string) => {
      try {
        await assignPlayerToSlot(intakeRequestId, slotId);
        toast.success(t('proposals.playerAssigned', { defaultValue: 'Player assigned to slot' }));
        refreshData();
        const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
        setScheduleSlots(updatedSlots);
      } catch (error: any) {
        toast.error(error.message);
      }
    },
    onUnassignPlayer: async (assignmentId: string) => {
      try {
        await unassignPlayer(assignmentId);
        toast.success(t('proposals.playerUnassigned', { defaultValue: 'Player returned to unplaced pool' }));
        refreshData();
        const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
        setScheduleSlots(updatedSlots);
      } catch (error: any) {
        toast.error(error.message);
      }
    },
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (!cycle) {
    return (
      <div className="container mx-auto px-4 py-6">
        <p className="text-muted-foreground">{t('common:notFound', 'Not found')}</p>
      </div>
    );
  }

  const period = `${format(new Date(cycle.start_date), 'MMM d', { locale })} – ${format(new Date(cycle.end_date), 'MMM d, yyyy', { locale })}`;

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/app/academy/cycles')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold truncate">{cycle.name}</h1>
              {getStatusBadge(cycle.status)}
              {cycle.type === 'event' && (
                <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-600 border-purple-500/20">
                  {t('type.event', 'Event')}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {period}
              {cycle.location?.name && ` · ${cycle.location.name}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCopyLink}>
              <ExternalLink className="h-4 w-4 mr-1" />
              {t('actions.shareLink')}
            </Button>
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setShowSettings(true)}>
              <Settings className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-9 w-9">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => navigate(`/app/academy/cycles/new?type=${cycle.type}&duplicateFrom=${cycle.id}`)}>
                  <Copy className="h-4 w-4 mr-2" />
                  {t('common:duplicate', 'Duplicate')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleToggleStatus}>
                  {cycle.status === 'open' ? (
                    <>
                      <ToggleLeft className="h-4 w-4 mr-2" />
                      {t('actions.closeEnrollment')}
                    </>
                  ) : (
                    <>
                      <ToggleRight className="h-4 w-4 mr-2" />
                      {t('actions.openEnrollment')}
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveStep('waitinglist')}>
                  <Clock className="h-4 w-4 mr-2" />
                  {t('nav.waitingList', 'Waiting List')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Workflow Steps Navigation */}
      {!isWaitingList && (
        <ProposalWorkflowSteps
          activeStep={activeStep as WorkflowStep}
          onStepClick={setActiveStep}
          registrationsCount={allCount}
          pendingLinkActions={pendingLinkActions}
          newCount={newCount}
          proposedCount={proposedCount}
          confirmedCount={confirmedCount}
        />
      )}

      {/* ==================== STEP 1: REGISTRATIONS ==================== */}
      {activeStep === 'registrations' && (
        <div className="space-y-4">
          {/* Status Filter + Actions */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
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
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowAddDialog(true)}
                className="h-8 text-xs"
              >
                <UserPlus className="h-3 w-3 mr-1" />
                {t('intakeRequests.addManual', { defaultValue: 'Add registration' })}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const cycleName = cycle?.name ?? 'all';
                  const date = format(new Date(), 'yyyy-MM-dd');
                  const locMap: Record<string, string> = {};
                  if (cycle?.location_id && cycle?.location?.name) {
                    locMap[cycle.location_id] = cycle.location.name;
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

            <ToggleGroup type="single" value={viewMode} onValueChange={(v) => v && setViewMode(v)} size="sm">
              <ToggleGroupItem value="list" aria-label="List view">
                <List className="h-4 w-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="schedule" aria-label="Schedule view">
                <CalendarDays className="h-4 w-4" />
              </ToggleGroupItem>
            </ToggleGroup>
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

          {/* Table or Schedule */}
          {viewMode === 'list' ? (
            <IntakeRequestsTable
              requests={filteredRequests}
              allRequests={requests}
              onRowClick={setSelectedRequest}
              emptyMessage={t('intakeRequests.noRequests')}
              emptyDescription={t('intakeRequests.noRequestsDescription')}
              playerLinks={playerLinksData}
              onLinkChanged={refreshData}
            />
          ) : (
            <ProposalScheduleGrid
              slots={scheduleSlots}
              trainerAvailabilityWindows={cycle?.settings?.trainer_availability_windows}
              {...scheduleGridHandlers}
              unplacedPlayers={unplacedPlayers}
            />
          )}
        </div>
      )}

      {/* ==================== STEP 2: REVIEW LINKS ==================== */}
      {activeStep === 'review-links' && (
        <div className="space-y-4">
          <PreGenerationReview
            requests={requests}
            playerLinks={playerLinksData}
            onLinkChanged={refreshData}
            onPlayerClick={(requestId) => {
              const req = requests.find(r => r.id === requestId);
              if (req) setSelectedRequest(req);
            }}
            onContinue={() => setActiveStep('generate')}
            hasPendingLinks={pendingLinkActions > 0}
          />
        </div>
      )}

      {/* ==================== STEP 3: GENERATE ==================== */}
      {activeStep === 'generate' && (
        <div className="space-y-4">
          {proposedCount > 0 ? (
            <div className="text-center py-8 space-y-3">
              <p className="text-muted-foreground">
                {t('workflow.alreadyGenerated', { defaultValue: 'Proposals have been generated. You can review them or reset to regenerate.' })}
              </p>
              <div className="flex gap-2 justify-center">
                <Button variant="outline" onClick={() => setShowResetConfirm(true)}>
                  <RotateCcw className="h-4 w-4 mr-1" />
                  {t('proposals.reset', { defaultValue: 'Reset' })}
                </Button>
                <Button onClick={() => setActiveStep('review-edit')}>
                  <Eye className="h-4 w-4 mr-1" />
                  {t('workflow.continueToReview', { defaultValue: 'Review proposals' })}
                </Button>
              </div>
            </div>
          ) : newCount === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {t('workflow.noNewRequests', { defaultValue: 'No new requests to generate proposals for.' })}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-8">
              <p className="text-muted-foreground text-center max-w-md">
                {t('workflow.generateIntro', { defaultValue: 'Generate proposals for {{count}} registrations. Configure matching preferences in the wizard.', count: newCount })}
              </p>
              <Button size="lg" onClick={() => setShowWizard(true)}>
                <Sparkles className="h-4 w-4 mr-2" />
                {t('proposals.generateAll', { defaultValue: 'Generate proposals' })}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ==================== STEP 4: REVIEW & EDIT ==================== */}
      {activeStep === 'review-edit' && (
        <div className="space-y-4">
          {proposedCount > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{t('proposals.schedulePreview', 'Schedule Preview')}</h3>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowResetConfirm(true)}>
                    <RotateCcw className="h-4 w-4 mr-1" />
                    {t('proposals.reset', { defaultValue: 'Reset' })}
                  </Button>
                  <Button size="sm" onClick={() => navigate('/app/academy/intake-requests/overview', { state: { slots: scheduleSlots, cycleId, backPath: `/app/academy/cycles/${cycleId}?step=approve` } })}>
                    <Eye className="h-4 w-4 mr-1" />
                    {t('workflow.continueToOverview', { defaultValue: 'Continue to Approve' })}
                  </Button>
                </div>
              </div>
              <ProposalScheduleGrid
                slots={scheduleSlots}
                trainerAvailabilityWindows={cycle?.settings?.trainer_availability_windows}
                {...scheduleGridHandlers}
                unplacedPlayers={unplacedPlayers}
              />
            </>
          ) : (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {t('workflow.noProposalsYet', { defaultValue: 'No proposals generated yet. Go back to the Generate step.' })}
              </p>
              <Button variant="outline" className="mt-3" onClick={() => setActiveStep('generate')}>
                {t('workflow.backToGenerate', { defaultValue: 'Back to Generate' })}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ==================== STEP 5: APPROVE & BOOK ==================== */}
      {activeStep === 'approve' && (
        <div className="space-y-4">
          {proposedCount > 0 || confirmedCount > 0 ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <p className="text-muted-foreground text-center max-w-md">
                {confirmedCount > 0
                  ? t('workflow.approvedSummary', { defaultValue: '{{count}} bookings confirmed.', count: confirmedCount })
                  : t('workflow.approveIntro', { defaultValue: 'Review the overview and approve proposals to create bookings.' })
                }
              </p>
              <Button size="lg" onClick={() => navigate('/app/academy/intake-requests/overview', { state: { slots: scheduleSlots, cycleId, backPath: `/app/academy/cycles/${cycleId}?step=approve` } })}>
                <Eye className="h-4 w-4 mr-2" />
                {t('workflow.viewOverview', { defaultValue: 'View overview' })}
              </Button>
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {t('workflow.noProposalsYet', { defaultValue: 'No proposals generated yet. Go back to the Generate step.' })}
              </p>
              <Button variant="outline" className="mt-3" onClick={() => setActiveStep('generate')}>
                {t('workflow.backToGenerate', { defaultValue: 'Back to Generate' })}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ==================== WAITING LIST (secondary) ==================== */}
      {isWaitingList && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{t('nav.waitingList', 'Waiting List')}</h3>
            <Button variant="outline" size="sm" onClick={() => setActiveStep('registrations')}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              {t('workflow.backToWorkflow', { defaultValue: 'Back to workflow' })}
            </Button>
          </div>
          <WaitingListTable ownerType="academy" ownerId={activeAcademy!.id} />
        </div>
      )}

      {/* Detail Sheet */}
      <IntakeRequestDetailSheet
        request={selectedRequest}
        open={!!selectedRequest}
        onOpenChange={(open) => !open && setSelectedRequest(null)}
        onStatusChange={refreshData}
        cycleId={cycleId}
        playerLinks={playerLinksData}
        allRequests={requests}
        onLinkChanged={refreshData}
      />

      {/* Generate Proposals Wizard */}
      {cycle && (
        <GenerateProposalsWizard
          open={showWizard}
          onOpenChange={setShowWizard}
          cycle={cycle}
          onGenerate={handleGenerateProposals}
          isGenerating={isGenerating}
          ownerType="academy"
          ownerId={activeAcademy!.id}
        />
      )}

      {/* Add Registration Dialog */}
      <AddIntakeRequestDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        cycleId={cycleId}
        cycles={cycle ? [cycle] : []}
        onSuccess={() => {
          setShowAddDialog(false);
          refreshData();
        }}
      />

      {/* Settings Sheet */}
      <Sheet open={showSettings} onOpenChange={setShowSettings}>
        <SheetContent side="right" className="sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t('nav.settings', 'Settings')}</SheetTitle>
          </SheetHeader>
          <div className="mt-6">
            <CycleForm
              cycle={cycle}
              ownerType="academy"
              ownerId={activeAcademy!.id}
              onSuccess={() => {
                toast.success(t('common:saved', 'Saved'));
                fetchCycle();
                setShowSettings(false);
              }}
              onCancel={() => setShowSettings(false)}
              formType={cycle.type === 'event' ? 'event' : 'registration'}
              locations={locations}
              trainers={trainers}
              trainerLocationMap={trainerLocationMap}
            />
          </div>
        </SheetContent>
      </Sheet>

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
