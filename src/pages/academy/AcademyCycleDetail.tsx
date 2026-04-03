import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format, differenceInWeeks } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
  Users,
  ClipboardList,
} from 'lucide-react';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getMarketingUrl } from '@/lib/domains';
import {
  getCycle,
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
import ProposalWorkflowSteps from '@/components/cycles/ProposalWorkflowSteps';
import AddIntakeRequestDialog from '@/components/cycles/AddIntakeRequestDialog';
import CycleForm from '@/components/cycles/CycleForm';
import WaitingListTable from '@/components/waitingList/WaitingListTable';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { logger } from '@/lib/logger';

export default function AcademyCycleDetail() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const { t, i18n } = useTranslation('cycles');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();
  const locale = i18n.language === 'nl' ? nl : enUS;

  // Active tab from URL
  const activeTab = searchParams.get('tab') || 'registrations';
  const setActiveTab = (tab: string) => {
    setSearchParams({ tab }, { replace: true });
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

  // Settings tab data
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

  // Load schedule slots when in schedule view
  useEffect(() => {
    if (viewMode === 'schedule' && cycleId) {
      getAvailableSlotsForCycle(cycleId)
        .then(setScheduleSlots)
        .catch(() => setScheduleSlots([]));
    } else {
      setScheduleSlots([]);
    }
  }, [viewMode, cycleId, requests]);

  // Auto-switch to schedule view when viewing proposals
  useEffect(() => {
    if (statusFilter === 'proposed' && filteredRequests.some(r => r.status === 'proposed')) {
      setViewMode('schedule');
    }
  }, [statusFilter, filteredRequests]);

  // Counts
  const allCount = requests.length;
  const newCount = requests.filter(r => r.status === 'new' && !r.skip_reason).length;
  const skippedCount = requests.filter(r => r.status === 'new' && r.skip_reason).length;
  const proposedCount = requests.filter(r => r.status === 'proposed').length;
  const confirmedCount = requests.filter(r => r.status === 'confirmed').length;

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
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="registrations">
            <Users className="h-4 w-4 mr-1.5" />
            {t('nav.registrations', 'Registrations')}
            {allCount > 0 && <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0">{allCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="proposals">
            <ClipboardList className="h-4 w-4 mr-1.5" />
            {t('nav.proposals', 'Proposals')}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings className="h-4 w-4 mr-1.5" />
            {t('nav.settings', 'Settings')}
          </TabsTrigger>
          <TabsTrigger value="waitinglist">
            <CalendarDays className="h-4 w-4 mr-1.5" />
            {t('nav.waitingList', 'Waiting List')}
          </TabsTrigger>
        </TabsList>

        {/* ==================== REGISTRATIONS TAB ==================== */}
        <TabsContent value="registrations" className="space-y-4">
          {/* Status Filter Tabs + View Toggle */}
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

          {/* Requests Table or Schedule Grid */}
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
              onPlayerClick={(intakeRequestId) => {
                const req = requests.find(r => r.id === intakeRequestId);
                if (req) setSelectedRequest(req);
              }}
              onMovePlayer={async (assignmentId, newSlotId) => {
                try {
                  await movePlayerAssignment(assignmentId, newSlotId);
                  toast.success(t('proposals.playerMoved', 'Player moved successfully'));
                  const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                  setScheduleSlots(updatedSlots);
                } catch (error: any) {
                  toast.error(error.message);
                }
              }}
              onMoveSlot={async (slotId, newTrainerId, newStartTime, newEndTime) => {
                try {
                  await moveSlot(slotId, newTrainerId, newStartTime, newEndTime);
                  toast.success(t('proposals.slotMoved', 'Slot moved successfully'));
                  const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                  setScheduleSlots(updatedSlots);
                } catch (error: any) {
                  toast.error(error.message);
                }
              }}
              onSwapSlots={async (slotAId, slotATrainer, slotAStart, slotAEnd, slotBId, slotBTrainer, slotBStart, slotBEnd) => {
                try {
                  await swapSlots(slotAId, slotATrainer, slotAStart, slotAEnd, slotBId, slotBTrainer, slotBStart, slotBEnd);
                  toast.success(t('proposals.slotsSwapped', 'Slots swapped successfully'));
                  const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                  setScheduleSlots(updatedSlots);
                } catch (error: any) {
                  toast.error(error.message);
                }
              }}
              onDeleteSlot={async (slotId) => {
                try {
                  await deleteSlot(slotId);
                  toast.success(t('proposals.slotDeleted', { defaultValue: 'Slot deleted' }));
                  const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                  setScheduleSlots(updatedSlots);
                  refreshData();
                } catch (error: any) {
                  toast.error(error.message);
                }
              }}
              onUndo={(previousSlots) => {
                setScheduleSlots(previousSlots);
                toast.info(t('proposals.undone', { defaultValue: 'Change undone — save or continue editing' }));
              }}
              unplacedPlayers={unplacedPlayers}
              onAssignPlayer={async (intakeRequestId, slotId) => {
                try {
                  await assignPlayerToSlot(intakeRequestId, slotId);
                  toast.success(t('proposals.playerAssigned', { defaultValue: 'Player assigned to slot' }));
                  refreshData();
                  const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                  setScheduleSlots(updatedSlots);
                } catch (error: any) {
                  toast.error(error.message);
                }
              }}
              onUnassignPlayer={async (assignmentId) => {
                try {
                  await unassignPlayer(assignmentId);
                  toast.success(t('proposals.playerUnassigned', { defaultValue: 'Player returned to unplaced pool' }));
                  refreshData();
                  const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                  setScheduleSlots(updatedSlots);
                } catch (error: any) {
                  toast.error(error.message);
                }
              }}
            />
          )}
        </TabsContent>

        {/* ==================== PROPOSALS TAB ==================== */}
        <TabsContent value="proposals" className="space-y-6">
          <ProposalWorkflowSteps
            cycles={[cycle]}
            selectedCycleId={cycle.id}
            onCycleChange={() => {}}
            newCount={newCount}
            proposedCount={proposedCount}
            confirmedCount={confirmedCount}
            onGenerate={() => setShowWizard(true)}
            onApproveAll={() => {}}
            onReset={() => setShowResetConfirm(true)}
            onAddManual={() => setShowAddDialog(true)}
            onShowOverview={() => navigate('/app/academy/intake-requests/overview', { state: { slots: scheduleSlots, cycleId, backPath: `/app/academy/cycles/${cycleId}?tab=proposals` } })}
            isGenerating={isGenerating}
            isResetting={isResetting}
            hideCycleSelector
          />

          {/* Inline schedule grid for proposals */}
          {proposedCount > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{t('proposals.schedulePreview', 'Schedule Preview')}</h3>
              </div>
              <ProposalScheduleGrid
                slots={scheduleSlots}
                trainerAvailabilityWindows={cycle?.settings?.trainer_availability_windows}
                onPlayerClick={(intakeRequestId) => {
                  const req = requests.find(r => r.id === intakeRequestId);
                  if (req) setSelectedRequest(req);
                }}
                onMovePlayer={async (assignmentId, newSlotId) => {
                  try {
                    await movePlayerAssignment(assignmentId, newSlotId);
                    toast.success(t('proposals.playerMoved', 'Player moved successfully'));
                    const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                    setScheduleSlots(updatedSlots);
                  } catch (error: any) {
                    toast.error(error.message);
                  }
                }}
                onMoveSlot={async (slotId, newTrainerId, newStartTime, newEndTime) => {
                  try {
                    await moveSlot(slotId, newTrainerId, newStartTime, newEndTime);
                    toast.success(t('proposals.slotMoved', 'Slot moved successfully'));
                    const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                    setScheduleSlots(updatedSlots);
                  } catch (error: any) {
                    toast.error(error.message);
                  }
                }}
                onSwapSlots={async (slotAId, slotATrainer, slotAStart, slotAEnd, slotBId, slotBTrainer, slotBStart, slotBEnd) => {
                  try {
                    await swapSlots(slotAId, slotATrainer, slotAStart, slotAEnd, slotBId, slotBTrainer, slotBStart, slotBEnd);
                    toast.success(t('proposals.slotsSwapped', 'Slots swapped successfully'));
                    const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                    setScheduleSlots(updatedSlots);
                  } catch (error: any) {
                    toast.error(error.message);
                  }
                }}
                onDeleteSlot={async (slotId) => {
                  try {
                    await deleteSlot(slotId);
                    toast.success(t('proposals.slotDeleted', { defaultValue: 'Slot deleted' }));
                    const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                    setScheduleSlots(updatedSlots);
                    refreshData();
                  } catch (error: any) {
                    toast.error(error.message);
                  }
                }}
                onUndo={(previousSlots) => {
                  setScheduleSlots(previousSlots);
                }}
                unplacedPlayers={unplacedPlayers}
                onAssignPlayer={async (intakeRequestId, slotId) => {
                  try {
                    await assignPlayerToSlot(intakeRequestId, slotId);
                    toast.success(t('proposals.playerAssigned', { defaultValue: 'Player assigned to slot' }));
                    refreshData();
                    const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                    setScheduleSlots(updatedSlots);
                  } catch (error: any) {
                    toast.error(error.message);
                  }
                }}
                onUnassignPlayer={async (assignmentId) => {
                  try {
                    await unassignPlayer(assignmentId);
                    toast.success(t('proposals.playerUnassigned', { defaultValue: 'Player returned to unplaced pool' }));
                    refreshData();
                    const updatedSlots = await getAvailableSlotsForCycle(cycleId!);
                    setScheduleSlots(updatedSlots);
                  } catch (error: any) {
                    toast.error(error.message);
                  }
                }}
              />
            </div>
          )}
        </TabsContent>

        {/* ==================== SETTINGS TAB ==================== */}
        <TabsContent value="settings">
          <div className="max-w-2xl">
            <CycleForm
              cycle={cycle}
              ownerType="academy"
              ownerId={activeAcademy!.id}
              onSuccess={() => {
                toast.success(t('common:saved', 'Saved'));
                fetchCycle();
              }}
              onCancel={() => setActiveTab('registrations')}
              formType={cycle.type === 'event' ? 'event' : 'registration'}
              locations={locations}
              trainers={trainers}
              trainerLocationMap={trainerLocationMap}
            />
          </div>
        </TabsContent>

        {/* ==================== WAITING LIST TAB ==================== */}
        <TabsContent value="waitinglist">
          <WaitingListTable ownerType="academy" ownerId={activeAcademy!.id} />
        </TabsContent>
      </Tabs>

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
