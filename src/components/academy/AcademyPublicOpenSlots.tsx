import { PublicAvailabilitySection } from '@/components/booking/PublicAvailabilitySection';

interface AcademyPublicOpenSlotsProps {
  academyId: string;
  academySlug: string;
  /** Academy timezone (academy_profiles.timezone) so times render academy-local, not browser-local. */
  timezone?: string;
}

/**
 * Academy public-page availability. Thin wrapper over the shared {@link PublicAvailabilitySection}
 * (also used by the trainer profile page) — supplies the academy owner descriptor, slug and timezone.
 */
export function AcademyPublicOpenSlots({ academyId, academySlug, timezone }: AcademyPublicOpenSlotsProps) {
  return (
    <PublicAvailabilitySection
      owner={{ type: 'academy', academyId }}
      academySlug={academySlug}
      timezone={timezone}
    />
  );
}
