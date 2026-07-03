import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ListPageSkeleton } from '@/components/ui/list-page-skeleton';
import { Plus, CalendarDays, PartyPopper } from 'lucide-react';
import { type Cycle } from '@/lib/cycles';
import { listRegistrationCycles } from '@/lib/registrations';
import CyclesTable from '@/components/cycles/CyclesTable';
import { useClubContext } from '@/components/club/ClubLayout';
import { logger } from '@/lib/logger';

interface LocationData {
  id: string;
  name: string;
  city: string;
}

export default function ClubCycles() {
  const { t } = useTranslation('cycles');
  const { toast } = useToast();
  const navigate = useNavigate();
  const { activeClub } = useClubContext();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [locations, setLocations] = useState<LocationData[]>([]);

  useEffect(() => {
    if (!activeClub) return;
    const clubLocation = activeClub.location;
    if (clubLocation) {
      setLocations([{ id: clubLocation.id, name: clubLocation.name, city: clubLocation.city || '' }]);
    }
  }, [activeClub]);

  const fetchCycles = async () => {
    if (!activeClub) return;

    setIsLoading(true);
    try {
      // Registrations page → dual-read the canonical registrations table UNIONed with legacy
      // registration/event cycles, deduped by source cycle (parity with AcademyRegistrations).
      const data = await listRegistrationCycles('club', activeClub.id);
      setCycles(data);
    } catch (error: any) {
      logger.error('Error fetching cycles', error as Error, { component: 'ClubCycles', clubId: activeClub?.id });
      toast({
        title: t('common:error'),
        description: getFriendlyErrorMessage(error, t('genericError', 'Something went wrong. Please try again.')),
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (activeClub) fetchCycles();
  }, [activeClub]);

  const handleDuplicate = (cycle: Cycle) => {
    navigate(`/app/club/registrations/new?type=registration&duplicateFrom=${cycle.id}`);
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <ListPageSkeleton />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('registration.openCycles', 'Registrations')}</h1>
          <p className="text-muted-foreground hidden sm:block">
            {t('noRegistrationsDescription', 'Create registrations to collect player interest')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => navigate('/app/club/registrations/new?type=registration')}>
            <Plus className="mr-2 h-4 w-4" />
            {t('createRegistration', 'Create Registration')}
          </Button>
          <Button variant="outline" onClick={() => navigate('/app/club/registrations/new?type=event')}>
            <PartyPopper className="mr-2 h-4 w-4" />
            {t('createEvent', 'Create Event')}
          </Button>
        </div>
      </div>

      {/* Cycles Table or Empty State */}
      {cycles.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title={t('noRegistrations', 'No registrations yet')}
          description={t('noRegistrationsDescription', 'Create a registration to start collecting player interest')}
          action={
            <Button onClick={() => navigate('/app/club/registrations/new?type=registration')}>
              <Plus className="mr-2 h-4 w-4" />
              {t('createRegistration', 'Create Registration')}
            </Button>
          }
        />
      ) : (
        <CyclesTable
          cycles={cycles}
          locations={locations}
          onEdit={(c) => navigate(`/app/club/registrations/${c.id}/edit`)}
          rowHref={(c) => `/app/club/registrations/${c.id}/edit`}
          onDuplicate={handleDuplicate}
          onDeleted={fetchCycles}
          ownerType="club"
          ownerSlug={activeClub.id}
        />
      )}
    </div>
  );
}
