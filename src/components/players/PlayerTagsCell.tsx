import { TagPicker } from '@/components/players/TagPicker';
import { PlayerTag } from './playerTagColors';

interface PlayerTagsCellProps {
  /** Owner: pass either academyId OR trainerId (one required). */
  academyId?: string;
  trainerId?: string;
  playerKey: { guest_player_id: string | null; profile_id: string | null };
  tags: PlayerTag[];
  selectedTagIds: string[];
  onTagsChange: (tags: PlayerTag[]) => void;
  onSelectedTagIdsChange: (tagIds: string[]) => void;
  onChanged?: () => void;
}

/** Table cell wrapper around shared TagPicker. */
export function PlayerTagsCell({
  academyId,
  trainerId,
  playerKey,
  tags,
  selectedTagIds,
  onTagsChange,
  onSelectedTagIdsChange,
  onChanged,
}: PlayerTagsCellProps) {
  return (
    <TagPicker
      academyId={academyId}
      trainerId={trainerId}
      playerKey={playerKey}
      tags={tags}
      selectedTagIds={selectedTagIds}
      onTagsChange={onTagsChange}
      onSelectedTagIdsChange={onSelectedTagIdsChange}
      onChanged={onChanged}
      variant="table"
    />
  );
}
