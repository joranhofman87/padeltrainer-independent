import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ArrowLeft, Sparkles, CheckCheck, UserPlus } from 'lucide-react';
import { 
  getCycles, 
  getIntakeRequestsWithProposals, 
  generateProposals,
  type Cycle, 
  type IntakeRequestWithProposal,
} from '@/lib/cycles';
import IntakeRequestsTable from '@/components/cycles/IntakeRequestsTable';
import IntakeRequestDetailSheet from '@/components/cycles/IntakeRequestDetailSheet';
import { GenerateProposalsWizard, type GenerateProposalsConfig } from '@/components/cycles/GenerateProposalsWizard';
import AddIntakeRequestDialog from '@/components/cycles/AddIntakeRequestDialog';
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
    } catch (error: any) {
      logger.error('Error fetching intake requests', error as Error, { component: 'TrainerIntakeRequests', trainerId });
      toast.error(error.message);
    } finally {
      setIsLoading(false);
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
    if (statusFilter !== 'all') {
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

  const selectedCycle = cycles.find(c => c.id === selectedCycleId);
  const newCount = requests.filter(r => r.status === 'new').length;
  const proposedCount = requests.filter(r => r.status === 'proposed').length;

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

        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div className="flex gap-2 items-center">
            <Select value={selectedCycleId} onValueChange={handleCycleChange}>
              <SelectTrigger className="w-[200px]">
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

      {/* Status Filter Tabs */}
      <Tabs value={statusFilter} onValueChange={setStatusFilter}>
        <TabsList>
          <TabsTrigger value="all">
            {t('intakeRequests.filters.all')} ({requests.length})
          </TabsTrigger>
          <TabsTrigger value="new">
            {t('intakeRequests.filters.new')} ({newCount})
          </TabsTrigger>
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

      {/* Requests Table */}
      <IntakeRequestsTable
        requests={filteredRequests}
        onRowClick={setSelectedRequest}
        emptyMessage={t('intakeRequests.noRequests')}
        emptyDescription={t('intakeRequests.noRequestsDescription')}
      />

      {/* Detail Sheet */}
      <IntakeRequestDetailSheet
        request={selectedRequest}
        open={!!selectedRequest}
        onOpenChange={(open) => !open && setSelectedRequest(null)}
        onStatusChange={fetchData}
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
    </div>
  );
}
