import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, CalendarDays, PartyPopper, CalendarPlus } from 'lucide-react';
import { type Cycle } from '@/lib/cycles';
import { listRegistrationCycles } from '@/lib/registrations';
import CyclesTable from '@/components/cycles/CyclesTable';
import RebookRoundsSection from '@/components/cycles/RebookRoundsSection';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyLocations } from '@/lib/academy';
import { logger } from '@/lib/logger';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';

interface LocationData {
  id: string;
  name: string;
  city: string;
}

export default function AcademyRegistrations() {
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
        logger.error('Error fetching academy locations', error as Error, { component: 'AcademyRegistrations' });
      }
    };
    fetchLocations();
  }, [activeAcademy]);

  const fetchCycles = useCallback(async () => {
    if (!activeAcademy) return;
    setIsLoading(true);
    try {
      const data = await listRegistrationCycles('academy', activeAcademy.id);
      setCycles(data);
    } catch (error) {
      logger.error('Error fetching cycles', error as Error, { component: 'AcademyRegistrations' });
      toast({ title: t('common:error'), description: getFriendlyErrorMessage(error, t('overview.loadError', 'Could not load cycles. Please try again.')), variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [activeAcademy, t, toast]);

  useEffect(() => {
    fetchCycles();
  }, [fetchCycles]);

  if (isLoading) {
    return (
      <AppPage>
        <Skeleton className="h-8 w-48 mb-6" />
        <Skeleton className="h-12 w-full mb-4" />
        <Skeleton className="h-64 w-full" />
      </AppPage>
    );
  }

  return (
    <AppPage>
      <PageHeader
        title={t('registration.openCycles', 'Registrations')}
        description={t('noRegistrationsDescription', 'Create registrations to collect player interest')}
        actions={
          <>
          <Button onClick={() => navigate('/app/academy/registrations/new?type=registration')}>
            <Plus className="h-4 w-4" />
            {t('createRegistration', 'Create Registration')}
          </Button>
          <Button variant="outline" onClick={() => navigate('/app/academy/registrations/new?type=event')}>
            <PartyPopper className="h-4 w-4" />
            {t('createEvent', 'Create Event')}
          </Button>
          <Button variant="outline" onClick={() => navigate('/app/academy/slot/generate')}>
            <CalendarPlus className="h-4 w-4" />
            {t('slotGenerator.cta', 'Snel sessies genereren')}
          </Button>
          </>
        }
      />

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">{t('createRegistration', 'Create Registration')}</span>
          {' — '}
          {t('actionExplainers.registration', 'An open form to collect player sign-ups for a training cycle.')}
        </p>
        <p>
          <span className="font-medium text-foreground">{t('createEvent', 'Create Event')}</span>
          {' — '}
          {t('actionExplainers.event', 'A one-off activity, such as a tournament or clinic.')}
        </p>
      </div>

      {activeAcademy && <RebookRoundsSection academyId={activeAcademy.id} />}

      {cycles.length === 0 ? (
        <div className="text-center py-16">
          <div className="mx-auto h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
            <CalendarDays className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="font-semibold mb-1 text-lg">{t('noRegistrations', 'No registrations yet')}</h3>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            {t('noRegistrationsDescription', 'Create a registration to start collecting player interest')}
          </p>
          <Button onClick={() => navigate('/app/academy/registrations/new?type=registration')}>
            <Plus className="mr-2 h-4 w-4" />
            {t('createRegistration', 'Create Registration')}
          </Button>
        </div>
      ) : (
        <CyclesTable
          cycles={cycles}
          locations={locations}
          onEdit={(c) => navigate(`/app/academy/registrations/${c.id}`)}
          onDuplicate={(c) => navigate(`/app/academy/registrations/new?type=registration&duplicateFrom=${c.id}`)}
          onDeleted={fetchCycles}
          ownerType="academy"
          ownerSlug={activeAcademy?.slug}
          ownerLogoUrl={activeAcademy?.logo_url}
        />
      )}
    </AppPage>
  );
}
