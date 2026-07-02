import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { AvailabilityCalendar } from '@/components/booking/AvailabilityCalendar';
import { GuestBookingDialog } from '@/components/booking/GuestBookingDialog';
import { GUEST_PAYFIRST_ENABLED } from '@/lib/bookingFlags';
import type { AvailabilityOwner } from '@/hooks/usePublicAvailability';
import type { PublicSlot } from '@/lib/publicAvailability';

interface PublicAvailabilitySectionProps {
  /** Whose availability to show — an academy or a trainer. */
  owner: AvailabilityOwner;
  /** Owner IANA timezone so times render owner-local (academy tz for an academy-trainer). */
  timezone?: string;
  /** Academy slug — enables the cyclus → registration fallback route when guest pay-first is off. */
  academySlug?: string;
  /** Show the booking section (with an empty state) even when there is no availability. */
  alwaysShow?: boolean;
}

/**
 * Shared PUBLIC availability section for the academy AND trainer profile pages. Renders the visual
 * two-pane {@link AvailabilityCalendar} for the owner and, on a slot/cyclus tap, opens the guest
 * pay-first {@link GuestBookingDialog} (single slot OR whole cyclus — it keys off slot.cyclus_id).
 *
 * Payment routing is server-authoritative: the edge fn's resolveSlotRecipient sends an
 * academy-trainer's charge to the ACADEMY's Mollie account (identical to how the webhook confirms),
 * so a trainer who belongs to an academy checks out through the academy automatically — no prop
 * needed here. Amount is the full slot/cyclus price (whole-slot when allow_single_booking=false).
 *
 * Renders nothing when there is no availability, unless `alwaysShow` is set (then it shows an
 * empty-state card). Extracted from AcademyPublicOpenSlots so the trainer page reuses the exact
 * same picker + booking flow.
 */
export function PublicAvailabilitySection({ owner, timezone, academySlug, alwaysShow }: PublicAvailabilitySectionProps) {
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  const [guestSlot, setGuestSlot] = useState<PublicSlot | null>(null);

  const handleSelect = (slot: PublicSlot) => {
    // Guest pay-first (flag on): the dialog books a single slot OR a whole cyclus and pays upfront.
    // The fallback (flag off) keeps the pre-pay-first routing: an academy cyclus → its registration
    // page, otherwise the trainer's book page.
    if (GUEST_PAYFIRST_ENABLED) {
      setGuestSlot(slot);
    } else if (slot.cyclus_id && academySlug) {
      navigate(localizePath(`/academies/${academySlug}/register/${slot.cyclus_id}`));
    } else if (slot.trainer_slug) {
      navigate(localizePath(`/book/${slot.trainer_slug}`));
    }
  };

  return (
    <>
      <AvailabilityCalendar owner={owner} onSelect={handleSelect} timezone={timezone} alwaysShow={alwaysShow} />
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
