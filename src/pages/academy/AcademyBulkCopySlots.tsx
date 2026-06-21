import { useAcademyContext } from '@/components/academy/AcademyLayout';
import BulkCopySlotsWizard from '@/components/cycles/BulkCopySlotsWizard';

export default function AcademyBulkCopySlots() {
  const { activeAcademy } = useAcademyContext();
  if (!activeAcademy) return null;
  return <BulkCopySlotsWizard ownerType="academy" ownerId={activeAcademy.id} backHref="/app/academy/agenda" />;
}
