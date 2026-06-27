import { PlayerDetailsCard, type LocationOption } from '@/components/players/PlayerDetailsCard';
import type { AcademyPlayerKind } from '@/lib/academyPlayerDetails';
import { saveTrainerPlayerDetails, type TrainerPlayerDetailsValues } from '@/lib/trainerPlayerDetails';

type TrainerPlayerDetailsCardProps = {
  kind: AcademyPlayerKind;
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  values: TrainerPlayerDetailsValues;
  locations: LocationOption[];
  tagIds?: string[];
  onSaved: (values: TrainerPlayerDetailsValues) => void;
};

/** Trainer-scoped player-details card — a thin wrapper over the shared {@link PlayerDetailsCard}
 *  (the single source of the form). Injects the trainer metadata writer and omits the phone field. */
export function TrainerPlayerDetailsCard({
  kind,
  trainerProfileId,
  guestPlayerId,
  profileId,
  values,
  locations,
  tagIds,
  onSaved,
}: TrainerPlayerDetailsCardProps) {
  return (
    <PlayerDetailsCard
      kind={kind}
      guestPlayerId={guestPlayerId}
      profileId={profileId}
      values={values}
      locations={locations}
      tagIds={tagIds}
      rolePrefix="trainer"
      fieldIdBase="trainer-player-details"
      onSaved={onSaved}
      save={({ form, allowedLocationIds }) =>
        saveTrainerPlayerDetails({ kind, trainerProfileId, guestPlayerId, profileId, form, allowedLocationIds, tagIds })}
    />
  );
}
