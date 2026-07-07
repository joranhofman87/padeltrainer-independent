import { useTranslation } from 'react-i18next';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import ExpensesManager from '@/components/expenses/ExpensesManager';

export default function AcademyExpenses() {
  const { t } = useTranslation('common');
  const { activeAcademy } = useAcademyContext();
  return (
    <AppPage>
      <PageHeader
        title={t('expenses.title', 'Uitgaven')}
        description={t('expenses.subtitle', 'Houd je uitgaven bij om je winst te zien op het dashboard.')}
      />
      {activeAcademy?.id ? <ExpensesManager owner={{ academyProfileId: activeAcademy.id }} /> : null}
    </AppPage>
  );
}
