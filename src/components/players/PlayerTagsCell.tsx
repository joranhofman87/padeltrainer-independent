import { TagPicker } from '@/components/players/TagPicker';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getTagColorClass, PlayerTag } from './playerTagColors';

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
  /** View-only: render the assigned tags as static chips (no picker). */
  readOnly?: boolean;
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
  readOnly,
}: PlayerTagsCellProps) {
  if (readOnly) {
    const selected = tags.filter((tag) => selectedTagIds.includes(tag.id));
    if (selected.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
    return (
      <div className="flex flex-wrap gap-1">
        {selected.map((tag) => (
          <Badge key={tag.id} variant="secondary" className={cn('text-[10px]', getTagColorClass(tag.color))}>
            {tag.name}
          </Badge>
        ))}
      </div>
    );
  }
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
