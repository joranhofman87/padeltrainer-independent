import type { SlotLocation } from "@/components/trainer/SlotLocationPicker";

export type AcademyCreateSlotPrerequisiteKind = "trainer" | "location";
export type AcademyCreateSlotPrerequisiteSeverity = "blocking" | "warning";

export interface AcademyCreateSlotPrerequisite {
  kind: AcademyCreateSlotPrerequisiteKind;
  severity: AcademyCreateSlotPrerequisiteSeverity;
}

/** Academy row from getAcademyLocations with nested location. */
export interface AcademyLocationRow {
  location: {
    id: string;
    name: string;
    city?: string | null;
    country?: string | null;
  };
}

export function mapAcademyLocationToSlotLocation(al: AcademyLocationRow): SlotLocation {
  return {
    id: al.location.id,
    name: al.location.name,
    city: al.location.city ?? "",
    country: al.location.country ?? undefined,
  };
}

export function mapAcademyLocationsToSlotLocations(rows: AcademyLocationRow[]): SlotLocation[] {
  return rows.map(mapAcademyLocationToSlotLocation);
}

export function getAcademyCreateSlotPrerequisites(
  activeTrainerCount: number,
  locationCount: number,
): AcademyCreateSlotPrerequisite[] {
  const prerequisites: AcademyCreateSlotPrerequisite[] = [];
  if (activeTrainerCount === 0) {
    prerequisites.push({ kind: "trainer", severity: "blocking" });
  }
  if (locationCount === 0) {
    prerequisites.push({ kind: "location", severity: "warning" });
  }
  return prerequisites;
}

export function hasBlockingAcademyCreateSlotPrerequisite(
  prerequisites: AcademyCreateSlotPrerequisite[],
): boolean {
  return prerequisites.some((p) => p.severity === "blocking");
}

export type BulkGenerateValidationError =
  | "empty_slots"
  | "no_academy_trainers"
  | "missing_slot_trainer"
  | "no_trainer_id";

/** Whether academy bulk create should seed one default recurring slot on first load. */
export function shouldInitializeAcademyDefaultBulkSlot(params: {
  academyId?: string;
  activeTrainerCount: number;
  prefillFromCyclusId?: string | null;
  existingBulkSlotCount: number;
}): boolean {
  if (params.existingBulkSlotCount > 0) {
    return false;
  }
  if (params.prefillFromCyclusId) {
    return false;
  }
  return Boolean(params.academyId) && params.activeTrainerCount > 0;
}

export function resolveAcademyDefaultBulkTrainerId(
  trainerId: string | null,
  availableTrainers?: { id: string }[],
): string | null {
  if (trainerId) {
    return trainerId;
  }
  return availableTrainers?.[0]?.id ?? null;
}

export function getBulkGenerateValidationError(params: {
  bulkSlotCount: number;
  academyId?: string;
  availableTrainers?: { id: string }[];
  bulkSlots: { trainerId: string | null }[];
  trainerId: string | null;
}): BulkGenerateValidationError | null {
  if (params.bulkSlotCount === 0) {
    return "empty_slots";
  }

  const isAcademyMode = Boolean(params.academyId);

  if (isAcademyMode) {
    if (!params.availableTrainers || params.availableTrainers.length === 0) {
      return "no_academy_trainers";
    }
    if (params.bulkSlots.some((s) => !s.trainerId)) {
      return "missing_slot_trainer";
    }
    return null;
  }

  if (!params.trainerId) {
    return "no_trainer_id";
  }

  return null;
}

/** Bulk slot config shape used when deciding booking enrollment. */
export type BulkSlotBookingConfig = {
  addPlayers: boolean;
  selectedPlayers: (string | null | undefined)[];
};

/** True when generate flow will attempt guest booking inserts. */
export function expectsBulkGuestBookings(bulkSlots: BulkSlotBookingConfig[]): boolean {
  return bulkSlots.some(
    (config) => config.addPlayers && config.selectedPlayers.some((id) => Boolean(id)),
  );
}

export type BulkGenerateBookingOutcome = "none" | "success" | "partial_failure";

/**
 * Classify booking result after slots were created.
 * partial_failure: enrollment was attempted but zero bookings were created or an insert error occurred.
 */
export function getBulkGenerateBookingOutcome(params: {
  expectedEnrollment: boolean;
  totalBookingsCreated: number;
  hadBookingInsertError: boolean;
}): BulkGenerateBookingOutcome {
  if (!params.expectedEnrollment) {
    return "none";
  }
  if (
    params.hadBookingInsertError ||
    params.totalBookingsCreated === 0
  ) {
    return "partial_failure";
  }
  return "success";
}

/**
 * notify-followers only supports the authenticated user's trainer_profiles row.
 * Academy managers often lack one; skip until academy-scoped notify exists.
 */
export function shouldSkipNotifyFollowersInAcademyMode(academyId?: string | null): boolean {
  return Boolean(academyId);
}
