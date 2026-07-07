import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import ExpensesManager from '@/components/expenses/ExpensesManager';

export default function TrainerExpenses() {
  const { t } = useTranslation('common');
  const { data: trainerId } = useQuery({
    queryKey: ['my-trainer-profile-id'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data } = await supabase.from('trainer_profiles').select('id').eq('user_id', user.id).maybeSingle();
      return (data?.id as string | undefined) ?? null;
    },
  });
  return (
    <AppPage>
      <PageHeader
        title={t('expenses.title', 'Uitgaven')}
        description={t('expenses.subtitle', 'Houd je uitgaven bij om je winst te zien op het dashboard.')}
      />
      {trainerId ? <ExpensesManager owner={{ trainerId }} /> : null}
    </AppPage>
  );
}
