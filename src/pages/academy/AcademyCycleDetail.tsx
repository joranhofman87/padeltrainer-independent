import { useState, useEffect, useMemo, useRef } from 'react';
import { CycleStatusBadge } from '@/components/cycles/CycleStatusBadge';
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
  RotateCcw,
  Eye,
  Clock,
} from 'lucide-react';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getShortCodesByTarget } from '@/lib/shortLinks';
import { shareUrlForRegistration } from '@/lib/cycleRegistrationUrl';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
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
  updateCycle,
  createProposalSlot,
  type IntakeRequestWithProposal,
  type SlotWithOccupancy,
} from '@/lib/cycles';
import { updateCyclePricing, type ExtraCost } from '@/lib/cycles';
import { syncRegistrationStatus } from '@/lib/registrations';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import { supabase } from '@/lib/supabaseClient';
import { setSlotVisibility } from '@/lib/slots';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { isTrainerSlotOverlapError } from '@/lib/slotConflicts';
import IntakeRequestsTable from '@/components/cycles/IntakeRequestsTable';
import ProposalScheduleGrid from '@/components/cycles/ProposalScheduleGrid';
import IntakeRequestDetailSheet from '@/components/cycles/IntakeRequestDetailSheet';
import { GenerateProposalsWizard, type GenerateProposalsConfig } from '@/components/cycles/GenerateProposalsWizard';
import ProposalWorkflowSteps, { type WorkflowStep } from '@/components/cycles/ProposalWorkflowSteps';
import AddIntakeRequestDialog from '@/components/cycles/AddIntakeRequestDialog';
import WaitingListTable from '@/components/waitingList/WaitingListTable';
import PreGenerationReview from '@/components/cycles/PreGenerationReview';
import CyclePricingCard from '@/components/cycles/CyclePricingCard';
import TentativeRosterSection from '@/components/cycles/TentativeRosterSection';
import { getSuggestedLinks, getLinkedIdsForRequest, getDismissedSuggestions } from '@/lib/suggestLinks';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCycleDetailQuery,
  useCycleRequestsQuery,
  useCyclePlayerLinksQuery,
  useScheduleSlotsQuery,
  useInvalidateProposalData,
} from '@/hooks/useProposalData';

export default function AcademyCycleDetail() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const { t, i18n } = useTranslation('cycles');
  const { t: tCommon } = useTranslation('common');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();
  const locale = i18n.language === 'nl' ? nl : enUS;

  // Active step from URL
  const rawStep = searchParams.get('step') || 'registrations';
  const activeStep: WorkflowStep = (['registrations', 'review-links', 'generate', 'review-edit', 'approve'].includes(rawStep) ? rawStep : 'registrations') as WorkflowStep;
  const isWaitingList = rawStep === 'waitinglist';
  const viewMode = searchParams.get('view') || 'list';
  const statusFilter = searchParams.get('status') || 'all';

  const setActiveStep = (step: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('step', step);
    setSearchParams(params, { replace: true });
  };
  const setViewMode = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value === 'list') params.delete('view'); else params.set('view', value);
    setSearchParams(params, { replace: true });
  };
  const setStatusFilter = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value === 'all') params.delete('status'); else params.set('status', value);
    setSearchParams(params, { replace: true });
  };

  const academyId = activeAcademy?.id ?? null;

  // TanStack Query — cached data
  const { data: cycle = null, isLoading: cycleLoading } = useCycleDetailQuery(cycleId);
  // Branded short-link code for this form (eagerly minted); prefer it when sharing.
  const { data: shortCode = null } = useQuery({
    queryKey: ['reg-short-code', cycleId],
    queryFn: () => getShortCodesByTarget('registration', [cycleId!]).then((m) => m.get(cycleId!) ?? null),
    enabled: !!cycleId,
  });
  const { data: requests = [] } = useCycleRequestsQuery('academy', academyId, cycleId);
  const { data: playerLinksData = [] } = useCyclePlayerLinksQuery(cycleId);

  const { invalidateAll, invalidateRequests, invalidateSlots } = useInvalidateProposalData();

  // Settings data query
  const { data: settingsData } = useQuery({
    queryKey: ['academy-settings', academyId],
    queryFn: async () => {
      if (!academyId) return null;
      const [academyTrainers, academyLocations, tzData] = await Promise.all([
        getAcademyTrainersWithProfiles(academyId),
        getAcademyLocations(academyId),
        supabase.from('academy_profiles').select('timezone').eq('id', academyId).maybeSingle(),
      ]);
      const timezone = (tzData.data as any)?.timezone || 'Europe/Amsterdam';

      const trainerIds = academyTrainers.map(t => t.trainer_profile_id);
      const tlMap: Record<string, string[]> = {};
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
      return {
        timezone,
        trainers: academyTrainers.map((t) => ({
          id: t.trainer_profile_id,
          name: t.profile?.full_name || 'Unknown',
          hourly_rate: t.trainer_profile?.hourly_rate || undefined,
        })),
        locations: academyLocations
          .filter((l) => l.location)
          .map((l) => ({
            id: l.location!.id,
            name: l.location!.name,
            city: l.location!.city || '',
          })),
        trainerLocationMap: tlMap,
      };
    },
    enabled: !!academyId,
    staleTime: 120_000,
  });

  const academyTimezone = settingsData?.timezone ?? 'Europe/Amsterdam';

  const isFirstLoad = cycleLoading && !cycle;


  // Schedule slots from TanStack Query — cached, no local state
  const shouldLoadSlots = viewMode === 'schedule' || activeStep === 'review-edit' || activeStep === 'approve';
  const { data: scheduleSlots = [] } = useScheduleSlotsQuery(cycleId, shouldLoadSlots);
  const queryClient = useQueryClient();
  const slotsQueryKey = ['proposal-slots', cycleId];
  const pendingMutationsRef = useRef(0);

  const setScheduleSlots = (updater: SlotWithOccupancy[] | ((prev: SlotWithOccupancy[]) => SlotWithOccupancy[])) => {
    queryClient.setQueryData<SlotWithOccupancy[]>(slotsQueryKey, old => {
      const prev = old ?? [];
      return typeof updater === 'function' ? updater(prev) : updater;
    });
  };

  const deepCloneSlots = () => JSON.parse(JSON.stringify(scheduleSlots)) as SlotWithOccupancy[];

  const safeInvalidateSlots = () => {
    if (pendingMutationsRef.current === 0 && cycleId) {
      invalidateSlots(cycleId);
    }
  };

  // Local state
  const [selectedRequest, setSelectedRequest] = useState<IntakeRequestWithProposal | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // Pricing state for Step 4 — initialized from cycle data
  const [pricingPricePerSession, setPricingPricePerSession] = useState<number | null>(null);
  const [pricingExtraCosts, setPricingExtraCosts] = useState<ExtraCost[]>([]);
  const [pricingSplitPayment, setPricingSplitPayment] = useState(false);
  const [pricingIncludeVat, setPricingIncludeVat] = useState(true);
  const [pricingInitialized, setPricingInitialized] = useState(false);
  const [isSavingPricing, setIsSavingPricing] = useState(false);

  // Initialize pricing state from cycle when it loads
  useEffect(() => {
    if (cycle && !pricingInitialized) {
      setPricingPricePerSession(cycle.price_per_session ?? null);
      setPricingExtraCosts((cycle.settings?.extra_costs as ExtraCost[]) || []);
      setPricingSplitPayment(cycle.settings?.split_payment ?? false);
      setPricingIncludeVat(cycle.settings?.prices_include_vat ?? true);
      setPricingInitialized(true);
    }
  }, [cycle, pricingInitialized]);

  const handleSavePricingAndContinue = async () => {
    if (!cycleId) return;
    setIsSavingPricing(true);
    try {
      await updateCyclePricing(cycleId, {
        price_per_session: pricingPricePerSession,
        extra_costs: pricingExtraCosts,
        split_payment: pricingSplitPayment,
        prices_include_vat: pricingIncludeVat,
      });
      if (academyId) invalidateAll('academy', academyId, cycleId);
      navigate('/app/academy/intake-requests/overview', {
        state: { slots: scheduleSlots, cycleId, backPath: `/app/academy/registrations/${cycleId}?step=approve`, timezone: academyTimezone },
      });
    } catch (error: any) {
      toast.error(getFriendlyErrorMessage(error, t('pricing.saveError', 'Failed to save pricing')));
    } finally {
      setIsSavingPricing(false);
    }
  };

  const handleContinueToApprove = () => {
    setActiveStep('approve');
  };

  useEffect(() => {
    setSelectedRequest(prev => {
      if (!prev) return null;
      return requests.find(r => r.id === prev.id) ?? null;
    });
  }, [requests]);

  // Filter requests by status
  const filteredRequests = useMemo(() => {
    let filtered = requests;
    if (statusFilter === 'skipped') {
      filtered = filtered.filter(r => r.status === 'new' && r.skip_reason);
    } else if (statusFilter === 'confirmed') {
      filtered = filtered.filter(r => r.status === 'confirmed' || (r.status as string) === 'booked');
    } else if (statusFilter !== 'all') {
      filtered = filtered.filter(r => r.status === statusFilter);
    }
    return filtered;
  }, [requests, statusFilter]);

  // Counts
  const allCount = requests.length;
  const newCount = requests.filter(r => r.status === 'new' && !r.skip_reason).length;
  const skippedCount = requests.filter(r => r.status === 'new' && r.skip_reason).length;
  const proposedCount = requests.filter(r => r.status === 'proposed').length;
  const confirmedCount = requests.filter(r => r.status === 'confirmed' || (r.status as string) === 'booked').length;

  // Pending link actions
  const pendingLinkActions = useMemo(() => {
    const dismissed = getDismissedSuggestions();
    const seenPairs = new Set<string>();
    let count = 0;
    for (const req of requests) {
      const linkedIds = new Set(getLinkedIdsForRequest(req.id, playerLinksData));
      const matches = getSuggestedLinks(req, requests, linkedIds, dismissed);
      for (const match of matches) {
        const pairKey = [req.id, match.id].sort().join('::');
        if (!seenPairs.has(pairKey)) { seenPairs.add(pairKey); count++; }
      }
    }
    return count;
  }, [requests, playerLinksData]);

  const unplacedPlayers = requests
    .filter(r => r.status === 'new' || r.status === 'rejected')
    .map(r => ({
      id: r.id, full_name: r.full_name, rating: r.rating, rating_system: r.rating_system,
      preferred_days: r.preferred_days, preferred_time_windows: r.preferred_time_windows,
      lesson_type: r.lesson_type, skip_reason: r.skip_reason, status: r.status,
      sessions_per_week: r.sessions_per_week,
    }));

  const allPlayersForGrid = requests
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

  const refreshData = () => {
    if (academyId && cycleId) {
      invalidateRequests('academy', academyId, cycleId);
    }
  };

  const refreshCycle = () => {
    if (cycleId) {
      invalidateAll('academy', academyId!, cycleId);
    }
  };

  const handleGenerateProposals = async (config: GenerateProposalsConfig) => {
    if (!cycleId) return;
    setIsGenerating(true);
    try {
      const result = await generateProposals(cycleId, config.weights, {
        startDate: config.startDate,
        trainerAvailability: config.trainerAvailability,
        additionalCriteria: config.additionalCriteria,
        linkStrategy: config.linkStrategy,
        fillIncompleteGroups: config.fillIncompleteGroups,
        maxGroupSize: config.maxGroupSize,
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
      setActiveStep('review-edit');
      if (academyId && cycleId) invalidateAll('academy', academyId, cycleId);
    } catch (error: any) {
      toast.error(
                isTrainerSlotOverlapError(error)
                  ? t('slotConflict.trainerOverlap', { ns: 'common' })
                  : getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })),
              );
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
      if (academyId && cycleId) invalidateAll('academy', academyId, cycleId);
    } catch (error: any) {
      toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
    } finally {
      setIsResetting(false);
    }
  };

  const { copy } = useCopyToClipboard();
  const handleCopyLink = async () => {
    if (!cycle || !activeAcademy) return;
    // Branded short link when minted, else the full academy registration URL — resolved centrally.
    const url = shareUrlForRegistration(shortCode, cycle.id, 'academy', activeAcademy.slug, i18n.language || 'nl');
    const ok = await copy(url);
    if (ok) toast.success(t('actions.linkCopied'));
    else toast.error(t('genericError', { defaultValue: 'Something went wrong. Please try again.' }));
  };

  const handleToggleStatus = async () => {
    if (!cycle) return;
    const newStatus = cycle.status === 'open' ? 'closed' : 'open';
    try {
      // A registration/event is a STANDALONE row (no cycles record) — update it directly; only a
      // real training cyclus goes through updateCycle (whose .single() would 0-row error here).
      if (cycle.type === 'registration' || cycle.type === 'event') {
        await syncRegistrationStatus(cycle.id, newStatus);
      } else {
        await updateCycle(cycle.id, { status: newStatus });
      }
      toast.success(t(`status.${newStatus}`));
      refreshCycle();
    } catch (error: any) {
      toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
    }
  };


  // Schedule grid event handlers with optimistic updates
  const scheduleGridHandlers = {
    onPlayerClick: (intakeRequestId: string) => {
      const req = requests.find(r => r.id === intakeRequestId);
      if (req) setSelectedRequest(req);
    },
    onMovePlayer: async (assignmentId: string, newSlotId: string) => {
      const prev = deepCloneSlots();
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
      pendingMutationsRef.current++;
      try {
        await movePlayerAssignment(assignmentId, newSlotId);
        toast.success(t('proposals.playerMoved', 'Player moved successfully'));
      } catch (error: any) {
        setScheduleSlots(prev);
        toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
      } finally {
        pendingMutationsRef.current--;
        safeInvalidateSlots();
      }
    },
    onMoveSlot: async (slotId: string, newTrainerId: string, newStartTime: string, newEndTime: string) => {
      const prev = deepCloneSlots();
      setScheduleSlots(slots => slots.map(s => s.id === slotId ? { ...s, trainer_id: newTrainerId, start_time: newStartTime, end_time: newEndTime } : s));
      pendingMutationsRef.current++;
      try {
        await moveSlot(slotId, newTrainerId, newStartTime, newEndTime);
        toast.success(t('proposals.slotMoved', 'Slot moved successfully'));
      } catch (error: any) {
        setScheduleSlots(prev);
        toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
      } finally {
        pendingMutationsRef.current--;
        safeInvalidateSlots();
      }
    },
    onSwapSlots: async (slotAId: string, slotATrainer: string, slotAStart: string, slotAEnd: string, slotBId: string, slotBTrainer: string, slotBStart: string, slotBEnd: string) => {
      const prev = deepCloneSlots();
      setScheduleSlots(slots => slots.map(s => {
        if (s.id === slotAId) return { ...s, trainer_id: slotATrainer, start_time: slotAStart, end_time: slotAEnd };
        if (s.id === slotBId) return { ...s, trainer_id: slotBTrainer, start_time: slotBStart, end_time: slotBEnd };
        return s;
      }));
      pendingMutationsRef.current++;
      try {
        await swapSlots(slotAId, slotATrainer, slotAStart, slotAEnd, slotBId, slotBTrainer, slotBStart, slotBEnd);
        toast.success(t('proposals.slotsSwapped', 'Slots swapped successfully'));
      } catch (error: any) {
        setScheduleSlots(prev);
        toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
      } finally {
        pendingMutationsRef.current--;
        safeInvalidateSlots();
      }
    },
    onDeleteSlot: async (slotId: string) => {
      const prev = deepCloneSlots();
      setScheduleSlots(slots => slots.filter(s => s.id !== slotId));
      pendingMutationsRef.current++;
      try {
        await deleteSlot(slotId);
        toast.success(t('proposals.slotDeleted', { defaultValue: 'Slot deleted' }));
        refreshData();
      } catch (error: any) {
        setScheduleSlots(prev);
        toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
      } finally {
        pendingMutationsRef.current--;
        safeInvalidateSlots();
      }
    },
    onUndo: (previousSlots: SlotWithOccupancy[]) => {
      setScheduleSlots(previousSlots);
      toast.info(t('proposals.undone', { defaultValue: 'Change undone — save or continue editing' }));
    },
    onAssignPlayer: async (intakeRequestId: string, slotId: string) => {
      const prev = deepCloneSlots();
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
      pendingMutationsRef.current++;
      try {
        await assignPlayerToSlot(intakeRequestId, slotId);
        toast.success(t('proposals.playerAssigned', { defaultValue: 'Player assigned to slot' }));
        refreshData();
      } catch (error: any) {
        setScheduleSlots(prev);
        toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
      } finally {
        pendingMutationsRef.current--;
        safeInvalidateSlots();
      }
    },
    onUnassignPlayer: async (assignmentId: string) => {
      const prev = deepCloneSlots();
      setScheduleSlots(slots => slots.map(s => ({
        ...s,
        current_assignments: s.current_assignments.filter((a: any) => a.id !== assignmentId),
      })));
      pendingMutationsRef.current++;
      try {
        await unassignPlayer(assignmentId);
        toast.success(t('proposals.playerUnassigned', { defaultValue: 'Player returned to unplaced pool' }));
        refreshData();
      } catch (error: any) {
        setScheduleSlots(prev);
        toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
      } finally {
        pendingMutationsRef.current--;
        safeInvalidateSlots();
      }
    },
    onCreateSlot: async (trainerId: string, startTime: string, endTime: string) => {
      if (!cycleId) return;
      const tempId = `temp-${Date.now()}`;
      const newSlot: SlotWithOccupancy = {
        id: tempId,
        trainer_id: trainerId,
        start_time: startTime,
        end_time: endTime,
        max_participants: (cycle?.settings as any)?.max_participants ?? 4,
        trainer_name: '',
        trainer_avatar: null,
        min_rating: null,
        max_rating: null,
        rating_system: null,
        cyclus_name: cycle?.name ?? null,
        is_blocked: false,
        is_public: true,
        current_assignments: [],
      };
      setScheduleSlots(prev => [...prev, newSlot]);
      pendingMutationsRef.current++;
      try {
        const result = await createProposalSlot(cycleId, trainerId, startTime, endTime);
        setScheduleSlots(prev => prev.map(s => s.id === tempId ? { ...s, id: result.id } : s));
        toast.success(t('proposals.slotCreated', { defaultValue: 'Slot created' }));
      } catch (error: any) {
        setScheduleSlots(prev => prev.filter(s => s.id !== tempId));
        toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
      } finally {
        pendingMutationsRef.current--;
        safeInvalidateSlots();
      }
    },
    onToggleSlotPrivacy: async (slotId: string, value: boolean) => {
      // Optimistic update
      setScheduleSlots(prev => prev.map(s => s.id === slotId ? { ...s, is_public: !value } : s));
      try {
        const { error } = await setSlotVisibility(slotId, !value);
        if (error) throw error;
      } catch (error: any) {
        // Revert
        setScheduleSlots(prev => prev.map(s => s.id === slotId ? { ...s, is_public: value } : s));
        toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
      }
    },
  };

  if (isFirstLoad) {
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
      <div className="container mx-auto px-4 py-6 space-y-4">
        <Button variant="ghost" size="icon" aria-label={tCommon('aria.goBack', 'Go back')} onClick={() => navigate('/app/academy/registrations')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">{tCommon('notFound.title', 'Page Not Found')}</h1>
          <p className="text-muted-foreground">{tCommon('notFound.description', "The page you're looking for doesn't exist or has been moved.")}</p>
        </div>
      </div>
    );
  }

  const period = `${format(new Date(cycle.start_date), 'MMM d', { locale })} – ${format(new Date(cycle.end_date), 'MMM d, yyyy', { locale })}`;

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label={tCommon('aria.goBack', 'Go back')} onClick={() => navigate('/app/academy/registrations')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold truncate">{cycle.name}</h1>
              <CycleStatusBadge status={cycle.status} />
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
            {(cycle.settings as Record<string, unknown> | null)?.rebook_payment_mode != null && (
              <Button variant="outline" size="sm" onClick={() => navigate(`/app/academy/cycles/${cycle.id}/rebook`)}>
                <RotateCcw className="h-4 w-4 mr-1" />
                {t('actions.manageRebooking', 'Beheer herboeking')}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleCopyLink}>
              <ExternalLink className="h-4 w-4 mr-1" />
              {t('actions.shareLink')}
            </Button>
            <Button variant="outline" size="icon" aria-label={tCommon('aria.settings', 'Settings')} className="h-9 w-9" onClick={() => navigate(`/app/academy/registrations/${cycle.id}/edit`)}>
              <Settings className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={tCommon('aria.openActionsMenu', 'Open actions menu')} className="h-9 w-9">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => navigate(`/app/academy/registrations/new?type=${cycle.type}&duplicateFrom=${cycle.id}`)}>
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
                    {t('intakeRequests.filters.confirmed')} ({confirmedCount})
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
                {t('intakeRequests.exportCsvShort', 'CSV')}
              </Button>
            </div>

            <ToggleGroup type="single" value={viewMode} onValueChange={(v) => v && setViewMode(v)} size="sm">
              <ToggleGroupItem value="list" aria-label={tCommon('aria.listView')}>
                <List className="h-4 w-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="schedule" aria-label={tCommon('aria.scheduleView')}>
                <CalendarDays className="h-4 w-4" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Skipped reasons summary */}
          {statusFilter === 'skipped' && Object.keys(skippedReasonCounts).length > 0 && (
            <Alert variant="default" className="bg-yellow-500/5 border-yellow-500/30">
              <AlertCircle className="h-4 w-4 text-yellow-600" />
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
                    disabled={isResetting || !cycleId}
                    onClick={async () => {
                      if (!cycleId) return;
                      setIsResetting(true);
                      try {
                        const result = await resetSkippedRequests(cycleId);
                        toast.success(t('proposals.resetSkippedSuccess', { count: result.reset, defaultValue: `Reset ${result.reset} skipped registrations` }));
                        if (academyId) invalidateAll('academy', academyId, cycleId);
                        setStatusFilter('new');
                      } catch (error: any) {
                        toast.error(getFriendlyErrorMessage(error, t('genericError', { defaultValue: 'Something went wrong. Please try again.' })));
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
              allPlayers={allPlayersForGrid}
            />
          )}

          {/* Tentative roster from priority rebooking — pending claims on this
              cycle's slots, grouped by series. Self-hides when there are none. */}
          {cycleId && <TentativeRosterSection cycleId={cycleId} />}
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
          ) : cycle ? (
            <GenerateProposalsWizard
              inline
              cycle={cycle}
              onGenerate={handleGenerateProposals}
              isGenerating={isGenerating}
              ownerType="academy"
              ownerId={activeAcademy!.id}
            />
          ) : null}
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
                  <Button size="sm" onClick={handleContinueToApprove}>
                    <Eye className="h-4 w-4 mr-1" />
                    {t('workflow.continueToOverview', { defaultValue: 'Continue to Approve' })}
                  </Button>
                </div>
              </div>

              {/* Pricing card moved to Approve step */}
              <ProposalScheduleGrid
                slots={scheduleSlots}
                trainerAvailabilityWindows={cycle?.settings?.trainer_availability_windows}
                {...scheduleGridHandlers}
                unplacedPlayers={unplacedPlayers}
                allPlayers={allPlayersForGrid}
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
            <>
              <CyclePricingCard
                pricePerSession={pricingPricePerSession}
                extraCosts={pricingExtraCosts}
                splitPayment={pricingSplitPayment}
                pricesIncludeVat={pricingIncludeVat}
                onPricePerSessionChange={setPricingPricePerSession}
                onExtraCostsChange={setPricingExtraCosts}
                onSplitPaymentChange={setPricingSplitPayment}
                onPricesIncludeVatChange={setPricingIncludeVat}
                academyProfileId={academyId}
              />
              <div className="flex flex-col items-center gap-4 py-8">
                <p className="text-muted-foreground text-center max-w-md">
                  {confirmedCount > 0
                    ? t('workflow.approvedSummary', { defaultValue: '{{count}} bookings confirmed.', count: confirmedCount })
                    : t('workflow.approveIntro', { defaultValue: 'Review the overview and approve proposals to create bookings.' })
                  }
                </p>
                <Button size="lg" onClick={handleSavePricingAndContinue} disabled={isSavingPricing}>
                  <Eye className="h-4 w-4 mr-2" />
                  {isSavingPricing
                    ? t('common:saving', 'Saving...')
                    : t('workflow.viewOverview', { defaultValue: 'View overview' })}
                </Button>
              </div>
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
        allowDelete={activeStep === 'registrations'}
      />

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
