import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Sparkles, CheckCheck, UserPlus, List, CalendarDays, RotateCcw, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  getCycles, 
  getIntakeRequestsWithProposals, 
  generateProposals,
  resetProposals,
  type Cycle, 
  type IntakeRequestWithProposal,
} from '@/lib/cycles';
import IntakeRequestsTable from '@/components/cycles/IntakeRequestsTable';
import ProposalScheduleGrid from '@/components/cycles/ProposalScheduleGrid';
import IntakeRequestDetailSheet from '@/components/cycles/IntakeRequestDetailSheet';
import { GenerateProposalsWizard, type GenerateProposalsConfig } from '@/components/cycles/GenerateProposalsWizard';
import AddIntakeRequestDialog from '@/components/cycles/AddIntakeRequestDialog';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { logger } from '@/lib/logger';

export default function AcademyIntakeRequests() {
  const { t } = useTranslation('cycles');
  const { activeAcademy } = useAcademyContext();
  const [searchParams, setSearchParams] = useSearchParams();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [requests, setRequests] = useState<IntakeRequestWithProposal[]>([]);
  const [filteredRequests, setFilteredRequests] = useState<IntakeRequestWithProposal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedCycleId, setSelectedCycleId] = useState<string>(searchParams.get('cycle') || 'all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedRequest, setSelectedRequest] = useState<IntakeRequestWithProposal | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [viewMode, setViewMode] = useState<string>('list');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const fetchData = async () => {
    if (!activeAcademy) return;

    setIsLoading(true);
    try {
      const [cyclesData, requestsData] = await Promise.all([
        getCycles('academy', activeAcademy.id),
        getIntakeRequestsWithProposals('academy', activeAcademy.id)
      ]);
      setCycles(cyclesData);
      setRequests(requestsData);
    } catch (error: any) {
      logger.error('Error fetching intake requests', error as Error, { component: 'AcademyIntakeRequests', academyId: activeAcademy?.id });
      toast.error(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (activeAcademy) fetchData();
  }, [activeAcademy]);

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
      });
      toast.success(t('proposals.generated', { count: result.generated }));
      setShowWizard(false);
      fetchData();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleResetProposals = async () => {
    if (selectedCycleId === 'all') return;
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
  const newCount = requests.filter(r => r.status === 'new' && !r.skip_reason).length;
  const skippedCount = requests.filter(r => r.status === 'new' && r.skip_reason).length;
  const proposedCount = requests.filter(r => r.status === 'proposed').length;

  const skippedReasonCounts = statusFilter === 'skipped'
    ? filteredRequests.reduce((acc, r) => {
        const reason = r.skip_reason;
        if (reason) acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    : {};

  if (isLoading) {
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
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{t('intakeRequests.title')}</h1>
          <p className="text-muted-foreground hidden sm:block">
            {t('intakeRequests.noRequestsDescription')}
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div className="flex gap-2 items-center">
            <Select value={selectedCycleId} onValueChange={handleCycleChange}>
              <SelectTrigger className={`w-[200px] ${selectedCycleId === 'all' && cycles.length > 0 ? 'border-primary ring-1 ring-primary/30' : ''}`}>
                <SelectValue placeholder="Select cycle" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('intakeRequests.filters.all')} cycles</SelectItem>
                {cycles.map(cycle => (
                  <SelectItem key={cycle.id} value={cycle.id}>{cycle.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowAddDialog(true)}>
              <UserPlus className="mr-2 h-4 w-4" />
              {t('intakeRequests.addManual')}
            </Button>
            {proposedCount > 0 && (
              <Button variant="outline" onClick={() => setShowResetConfirm(true)} disabled={isResetting}>
                <RotateCcw className="mr-2 h-4 w-4" />
                {t('proposals.reset', { defaultValue: 'Reset proposals' })}
              </Button>
            )}
            {proposedCount > 0 && (
              <Button variant="outline">
                <CheckCheck className="mr-2 h-4 w-4" />
                {t('proposals.approveAll')}
              </Button>
            )}
            <Button 
              onClick={() => setShowWizard(true)}
              disabled={selectedCycleId === 'all' || newCount === 0}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              {t('proposals.generateAll')}
            </Button>
          </div>
        </div>
      </div>

      {/* Cycle selection hint */}
      {selectedCycleId === 'all' && cycles.length > 0 && (
        <Alert variant="default" className="bg-muted/50 border-dashed">
          <Info className="h-4 w-4" />
          <AlertDescription>{t('intakeRequests.selectCycleHint')}</AlertDescription>
        </Alert>
      )}

      {/* Status Filter Tabs + View Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <Tabs value={statusFilter} onValueChange={setStatusFilter}>
          <TabsList>
            <TabsTrigger value="all">
              {t('intakeRequests.filters.all')} ({requests.length})
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
        />
      ) : (
        <ProposalScheduleGrid
          requests={filteredRequests}
          onBlockClick={setSelectedRequest}
        />
      )}

      {/* Detail Sheet */}
      <IntakeRequestDetailSheet
        request={selectedRequest}
        open={!!selectedRequest}
        onOpenChange={(open) => !open && setSelectedRequest(null)}
        onStatusChange={fetchData}
      />

      {/* Generate Proposals Wizard */}
      {selectedCycle && (
        <GenerateProposalsWizard
          open={showWizard}
          onOpenChange={setShowWizard}
          cycle={selectedCycle}
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
