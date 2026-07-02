import { useAcademyContext } from '@/components/academy/AcademyLayout';
import RebookCohortWizard from '@/components/cycles/RebookCohortWizard';

export default function AcademyRebookCohort() {
  const { activeAcademy } = useAcademyContext();
  if (!activeAcademy) return null;
  return <RebookCohortWizard academyProfileId={activeAcademy.id} backHref="/app/academy/sessions" />;
}
