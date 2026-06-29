import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CalendarPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SlotGeneratorWizard } from '@/components/cycles/SlotGeneratorWizard';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';

/** Trainer-side entry for the quick slot/cycle generator (self — no trainer picker). */
export default function TrainerGenerateSlots() {
  const { t } = useTranslation('trainer');
  const navigate = useNavigate();
  const { user } = useAuth();
  const [trainerId, setTrainerId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setTrainerId(data.id);
      });
  }, [user]);

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
      <main className="container mx-auto px-4 py-6">
        <div className="max-w-2xl">
          {trainerId && (
            <SlotGeneratorWizard
              ownerType="trainer"
              ownerId={trainerId}
              backHref="/app/trainer/cycles"
              trainerSelection={{ mode: 'self', trainerId }}
            />
          )}
        </div>
      </main>
    </>
  );
}
