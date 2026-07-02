import { useAcademyContext } from '@/components/academy/AcademyLayout';
import AcademyNewRoundWizard from '@/components/cycles/AcademyNewRoundWizard';

export default function AcademyBulkCopySlots() {
  const { activeAcademy } = useAcademyContext();
  if (!activeAcademy) return null;
  return <AcademyNewRoundWizard academyProfileId={activeAcademy.id} backHref="/app/academy/sessions" />;
}
