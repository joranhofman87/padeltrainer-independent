import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, CalendarDays } from 'lucide-react';
import { getCyclesWithCounts, type Cycle } from '@/lib/cycles';
import CyclesTable from '@/components/cycles/CyclesTable';
import CycleForm from '@/components/cycles/CycleForm';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import { logger } from '@/lib/logger';

interface LocationData {
  id: string;
  name: string;
  city: string;
}

export default function AcademyCycles() {
  const { t } = useTranslation('cycles');
  const { toast } = useToast();
  const { activeAcademy } = useAcademyContext();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingCycle, setEditingCycle] = useState<Cycle | null>(null);
  const [trainers, setTrainers] = useState<{ id: string; name: string }[]>([]);
  const [locations, setLocations] = useState<LocationData[]>([]);

  // Fetch academy trainers and locations for the form
  useEffect(() => {
    const fetchData = async () => {
      if (!activeAcademy) return;
      try {
        const [academyTrainers, academyLocations] = await Promise.all([
          getAcademyTrainersWithProfiles(activeAcademy.id),
          getAcademyLocations(activeAcademy.id),
        ]);
        
        setTrainers(
          academyTrainers.map((t) => ({
            id: t.trainer_profile_id,
            name: t.profile?.full_name || 'Unknown',
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
      } catch (error) {
        logger.error('Error fetching academy data', error as Error, { component: 'AcademyCycles', academyId: activeAcademy?.id });
      }
    };
    fetchData();
  }, [activeAcademy]);

  const fetchCycles = async () => {
    if (!activeAcademy) return;

    setIsLoading(true);
    try {
      const data = await getCyclesWithCounts('academy', activeAcademy.id);
      setCycles(data);
    } catch (error: any) {
      logger.error('Error fetching cycles', error as Error, { component: 'AcademyCycles', academyId: activeAcademy?.id });
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

  const handleDuplicate = (cycle: Cycle) => {
    // Pre-fill form with existing cycle data (but new name)
    const duplicatedCycle: Cycle = {
      ...cycle,
      id: '', // Will be generated
      name: `${cycle.name} (${t('common:copy', 'Copy')})`,
      status: 'draft',
    };
    setEditingCycle(duplicatedCycle);
    setShowCreateDialog(true);
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Skeleton className="h-8 w-48 mb-6" />
        <Skeleton className="h-12 w-full mb-4" />
        <Skeleton className="h-64 w-full" />
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
            {t('academyDescription')}
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('createCycle')}
        </Button>
      </div>

      {/* Cycles Table or Empty State */}
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
        <CyclesTable
          cycles={cycles}
          locations={locations}
          onEdit={(c) => setEditingCycle(c)}
          onDuplicate={handleDuplicate}
          onDeleted={fetchCycles}
          ownerType="academy"
        />
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
          cycle={editingCycle && editingCycle.id ? editingCycle : undefined}
          ownerType="academy"
          ownerId={activeAcademy.id}
          onSuccess={handleCycleCreated}
          trainers={trainers}
          locations={locations}
        />
      )}
    </div>
  );
}
