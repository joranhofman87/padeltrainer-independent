import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, CalendarDays, PartyPopper } from 'lucide-react';
import { getCyclesWithCounts, type Cycle } from '@/lib/cycles';
import CyclesTable from '@/components/cycles/CyclesTable';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyLocations } from '@/lib/academy';
import { logger } from '@/lib/logger';

interface LocationData {
  id: string;
  name: string;
  city: string;
}

export default function AcademyCycles() {
  const { t } = useTranslation('cycles');
  const { toast } = useToast();
  const navigate = useNavigate();
  const { activeAcademy } = useAcademyContext();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [locations, setLocations] = useState<LocationData[]>([]);

  useEffect(() => {
    const fetchLocations = async () => {
      if (!activeAcademy) return;
      try {
        const academyLocations = await getAcademyLocations(activeAcademy.id);
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
        logger.error('Error fetching academy locations', error as Error, { component: 'AcademyCycles' });
      }
    };
    fetchLocations();
  }, [activeAcademy]);

  const fetchCycles = async () => {
    if (!activeAcademy) return;
    setIsLoading(true);
    try {
      const data = await getCyclesWithCounts('academy', activeAcademy.id);
      setCycles(data);
    } catch (error: any) {
      logger.error('Error fetching cycles', error as Error, { component: 'AcademyCycles' });
      toast({ title: t('common:error'), description: error.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (activeAcademy) fetchCycles();
  }, [activeAcademy]);

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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('registration.openCycles', 'Registrations')}</h1>
          <p className="text-muted-foreground hidden sm:block">
            {t('noRegistrationsDescription', 'Create registrations to collect player interest')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => navigate('/app/academy/cycles/new?type=registration')}>
            <Plus className="mr-2 h-4 w-4" />
            {t('createRegistration', 'Create Registration')}
          </Button>
          <Button variant="outline" onClick={() => navigate('/app/academy/cycles/new?type=event')}>
            <PartyPopper className="mr-2 h-4 w-4" />
            {t('createEvent', 'Create Event')}
          </Button>
        </div>
      </div>

      {cycles.length === 0 ? (
        <div className="text-center py-16">
          <div className="mx-auto h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
            <CalendarDays className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="font-semibold mb-1 text-lg">{t('noRegistrations', 'No registrations yet')}</h3>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            {t('noRegistrationsDescription', 'Create a registration to start collecting player interest')}
          </p>
          <Button onClick={() => navigate('/app/academy/cycles/new?type=registration')}>
            <Plus className="mr-2 h-4 w-4" />
            {t('createRegistration', 'Create Registration')}
          </Button>
        </div>
      ) : (
        <CyclesTable
          cycles={cycles}
          locations={locations}
          onEdit={(c) => navigate(`/app/academy/cycles/${c.id}/edit`)}
          onDuplicate={(c) => navigate(`/app/academy/cycles/new?type=registration&duplicateFrom=${c.id}`)}
          onDeleted={fetchCycles}
          ownerType="academy"
          ownerSlug={activeAcademy?.slug}
        />
      )}
    </div>
  );
}
