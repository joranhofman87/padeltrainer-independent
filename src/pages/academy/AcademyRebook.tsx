import { useTranslation } from 'react-i18next';
import RebookRoundsSection from '@/components/cycles/RebookRoundsSection';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Rebooking hub — the "keep your spot for next term" rounds live here on their own page (they used
 * to sit at the top of Registrations, which conflated two different concerns). A round is STARTED
 * from the Sessions hub ("Volgende ronde opzetten"); this page lists + manages the running rounds.
 */
export default function AcademyRebook() {
  const { t } = useTranslation('cycles');
  const { activeAcademy } = useAcademyContext();

  return (
    <AppPage>
      <PageHeader
        title={t('rebookManage.pageTitle', 'Herboekingen')}
        description={t('rebookManage.pageDescription', 'Beheer lopende herboekingsrondes: wie reageerde, wie betaalde en welke plekken open staan.')}
      />
      {activeAcademy ? (
        <RebookRoundsSection academyId={activeAcademy.id} timezone={activeAcademy.timezone || undefined} />
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </AppPage>
  );
}
