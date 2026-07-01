import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { AvailabilityPicker } from '@/components/booking/AvailabilityPicker';
import type { PublicSlot } from '@/lib/publicAvailability';

interface AcademyPublicOpenSlotsProps {
  academyId: string;
  academySlug: string;
  /** Academy timezone (academy_profiles.timezone) so times render academy-local, not browser-local. */
  timezone?: string;
}

/**
 * Academy public-page availability. Thin wrapper: the shared {@link AvailabilityPicker} owns the
 * visual picker + data (usePublicAvailability); this only supplies the academy's owner descriptor,
 * timezone, and the academy-specific booking route (cyclus → register, single slot → the trainer's
 * book page). Renders nothing when there is no availability.
 */
export function AcademyPublicOpenSlots({ academyId, academySlug, timezone }: AcademyPublicOpenSlotsProps) {
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();

  const handleSelect = (slot: PublicSlot) => {
    if (slot.cyclus_id) {
      navigate(localizePath(`/academies/${academySlug}/register/${slot.cyclus_id}`));
    } else if (slot.trainer_slug) {
      navigate(localizePath(`/book/${slot.trainer_slug}`));
    }
  };

  return <AvailabilityPicker owner={{ type: 'academy', academyId }} onSelect={handleSelect} timezone={timezone} />;
}
