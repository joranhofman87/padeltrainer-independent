import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { AvailabilityPicker } from '@/components/booking/AvailabilityPicker';
import { GuestBookingDialog } from '@/components/booking/GuestBookingDialog';
import { GUEST_PAYFIRST_ENABLED } from '@/lib/bookingFlags';
import type { PublicSlot } from '@/lib/publicAvailability';

interface AcademyPublicOpenSlotsProps {
  academyId: string;
  academySlug: string;
  /** Academy timezone (academy_profiles.timezone) so times render academy-local, not browser-local. */
  timezone?: string;
}

/**
 * Academy public-page availability. Thin wrapper: the shared {@link AvailabilityPicker} owns the
 * visual picker + data (usePublicAvailability); this supplies the academy's owner descriptor,
 * timezone, and the booking routing. A cyclus tap goes to the registration flow; a single-slot tap
 * opens guest pay-first ({@link GuestBookingDialog}) once the edge functions are deployed
 * (GUEST_PAYFIRST_ENABLED), else falls back to the trainer's book page. Renders nothing when there
 * is no availability.
 */
export function AcademyPublicOpenSlots({ academyId, academySlug, timezone }: AcademyPublicOpenSlotsProps) {
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  const [guestSlot, setGuestSlot] = useState<PublicSlot | null>(null);

  const handleSelect = (slot: PublicSlot) => {
    // Guest pay-first (once deployed): the dialog books a single slot OR a whole
    // cyclus (it keys off slot.cyclus_id). Until the flag is flipped, keep today's
    // routing (cyclus → registration, single → the trainer's book page).
    if (GUEST_PAYFIRST_ENABLED) {
      setGuestSlot(slot);
    } else if (slot.cyclus_id) {
      navigate(localizePath(`/academies/${academySlug}/register/${slot.cyclus_id}`));
    } else if (slot.trainer_slug) {
      navigate(localizePath(`/book/${slot.trainer_slug}`));
    }
  };

  return (
    <>
      <AvailabilityPicker owner={{ type: 'academy', academyId }} onSelect={handleSelect} timezone={timezone} />
      <GuestBookingDialog
        slot={guestSlot}
        open={guestSlot !== null}
        onOpenChange={(o) => {
          if (!o) setGuestSlot(null);
        }}
        timezone={timezone ?? 'Europe/Amsterdam'}
      />
    </>
  );
}
