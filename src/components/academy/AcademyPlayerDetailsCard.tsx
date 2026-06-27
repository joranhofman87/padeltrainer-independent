import { PlayerDetailsCard, type LocationOption } from '@/components/players/PlayerDetailsCard';
import {
  type AcademyPlayerDetailsValues,
  type AcademyPlayerKind,
  saveAcademyPlayerDetails,
} from '@/lib/academyPlayerDetails';

type AcademyPlayerDetailsCardProps = {
  kind: AcademyPlayerKind;
  academyProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  values: AcademyPlayerDetailsValues;
  locations: LocationOption[];
  tagIds?: string[];
  onSaved: (values: AcademyPlayerDetailsValues) => void;
};

/** Academy-scoped player-details card — a thin wrapper over the shared {@link PlayerDetailsCard}
 *  (the single source of the form). Injects the academy metadata writer and shows the phone field. */
export function AcademyPlayerDetailsCard({
  kind,
  academyProfileId,
  guestPlayerId,
  profileId,
  values,
  locations,
  tagIds,
  onSaved,
}: AcademyPlayerDetailsCardProps) {
  return (
    <PlayerDetailsCard
      kind={kind}
      guestPlayerId={guestPlayerId}
      profileId={profileId}
      values={values}
      locations={locations}
      tagIds={tagIds}
      showPhone
      rolePrefix="academy"
      fieldIdBase="player-details"
      onSaved={onSaved}
      save={({ form, allowedLocationIds }) =>
        saveAcademyPlayerDetails({ kind, academyProfileId, guestPlayerId, profileId, form, allowedLocationIds, tagIds })}
    />
  );
}
