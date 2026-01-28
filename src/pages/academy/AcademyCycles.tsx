import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, CalendarDays } from 'lucide-react';
import { getCycles, type Cycle } from '@/lib/cycles';
import CycleCard from '@/components/cycles/CycleCard';
import CycleForm from '@/components/cycles/CycleForm';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainersWithProfiles } from '@/lib/academy';

export default function AcademyCycles() {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  const { toast } = useToast();
  const { activeAcademy } = useAcademyContext();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingCycle, setEditingCycle] = useState<Cycle | null>(null);
  const [trainers, setTrainers] = useState<{ id: string; name: string }[]>([]);

  // Fetch academy trainers for the form
  useEffect(() => {
    const fetchTrainers = async () => {
      if (!activeAcademy) return;
      try {
        const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
        setTrainers(
          academyTrainers.map((t) => ({
            id: t.trainer_profile_id,
            name: t.profile?.full_name || 'Unknown',
          }))
        );
      } catch (error) {
        console.error('Error fetching trainers:', error);
      }
    };
    fetchTrainers();
  }, [activeAcademy]);

  const fetchCycles = async () => {
    if (!activeAcademy) return;

    setIsLoading(true);
    try {
      const data = await getCycles('academy', activeAcademy.id);
      setCycles(data);
    } catch (error: any) {
      console.error('Error fetching cycles:', error);
      toast({
        title: t('common:error'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (activeAcademy) fetchCycles();
  }, [activeAcademy]);

  const handleCycleCreated = () => {
    setShowCreateDialog(false);
    setEditingCycle(null);
    fetchCycles();
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground hidden sm:block">
            {t('academyDescription', 'Create and manage registration cycles for your academy programs')}
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('createCycle')}
        </Button>
      </div>

      {/* Cycles Grid */}
      {cycles.length === 0 ? (
        <div className="text-center py-16">
          <div className="mx-auto h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
            <CalendarDays className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="font-semibold mb-1 text-lg">{t('noCycles')}</h3>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            {t('noCyclesDescription')}
          </p>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t('createCycle')}
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {cycles.map((cycle) => (
            <CycleCard
              key={cycle.id}
              cycle={cycle}
              onEdit={(c) => setEditingCycle(c)}
              onDeleted={fetchCycles}
            />
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      {activeAcademy && (
        <CycleForm
          open={showCreateDialog || !!editingCycle}
          onOpenChange={(open) => {
            if (!open) {
              setShowCreateDialog(false);
              setEditingCycle(null);
            }
          }}
          cycle={editingCycle || undefined}
          ownerType="academy"
          ownerId={activeAcademy.id}
          onSuccess={handleCycleCreated}
          trainers={trainers}
        />
      )}
    </div>
  );
}
