import { useSearchParams } from 'react-router-dom';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import RebookCohortWizard from '@/components/cycles/RebookCohortWizard';

export default function AcademyRebookCohort() {
  const { activeAcademy } = useAcademyContext();
  // ?extendRound=<rebook_round_id> → the wizard ADDS groups to that existing round
  // (prefilled from the round; skips groups already in it) instead of starting a new one.
  const [searchParams] = useSearchParams();
  const extendRoundId = searchParams.get('extendRound');
  if (!activeAcademy) return null;
  return (
    <RebookCohortWizard
      academyProfileId={activeAcademy.id}
      backHref="/app/academy/sessions"
      extendRoundId={extendRoundId}
    />
  );
}
