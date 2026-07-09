import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CalendarPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SlotGeneratorWizard } from '@/components/cycles/SlotGeneratorWizard';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { AcademyCreateSlotPrerequisites } from '@/components/academy/AcademyCreateSlotPrerequisites';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import {
  hasBlockingAcademyCreateSlotPrerequisite,
  getAcademyCreateSlotPrerequisites,
  mapAcademyLocationsToSlotLocations,
} from '@/lib/academyCreateSlot';
import type { SlotLocation } from '@/components/slots/SlotLocationPicker';

/** Academy-side entry for the quick slot/cycle generator (trainer is picked from the academy roster). */
export default function AcademyGenerateSlots() {
  const { t } = useTranslation('academy');
  const navigate = useNavigate();
  const { activeAcademy } = useAcademyContext();
  const [trainers, setTrainers] = useState<{ id: string; name: string }[]>([]);
  const [locations, setLocations] = useState<SlotLocation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeAcademy) return;
    let cancelled = false;
    setLoading(true);
    const load = async () => {
      try {
        const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
        const list = academyTrainers
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((tr: any) => tr.status === 'active' && tr.trainer_profile)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((tr: any) => ({ id: tr.trainer_profile.id, name: tr.profile?.full_name || 'Unknown' }));
        if (cancelled) return;
        setTrainers(list);
        const locs = await getAcademyLocations(activeAcademy.id);
        if (cancelled) return;
        setLocations(mapAcademyLocationsToSlotLocations(locs));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAcademy?.id]);

  const prerequisites = getAcademyCreateSlotPrerequisites(trainers.length, locations.length);
  const blocked = hasBlockingAcademyCreateSlotPrerequisite(prerequisites);

  return (
    <>
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-3 flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label={t('common:goBack', 'Go back')} onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5" />
            <h1 className="text-xl font-bold">{t('calendar.generateTitle', 'Snel sessies genereren')}</h1>
          </div>
        </div>
      </div>
      <main className="container mx-auto px-4 py-6 max-w-2xl w-full">
        {loading ? (
          <Skeleton className="h-64 w-full rounded-lg" />
        ) : (
          <>
            <div className="mb-4">
              <AcademyCreateSlotPrerequisites activeTrainerCount={trainers.length} locationCount={locations.length} />
            </div>
            {activeAcademy && !blocked && (
              <SlotGeneratorWizard
                ownerType="academy"
                ownerId={activeAcademy.id}
                backHref="/app/academy/registrations"
                trainerSelection={{ mode: 'pick', trainers }}
                availableLocations={locations}
                manageLocationsHref="/app/academy/locations"
              />
            )}
          </>
        )}
      </main>
    </>
  );
}
