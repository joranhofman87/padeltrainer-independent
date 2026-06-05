import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { getTagColorClass, PlayerTag } from '@/components/players/playerTagColors';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';
import { Loader2, Plus, X } from 'lucide-react';
import {
  appendTagToCatalog,
  canOfferCreateTag,
  getUnassignedTags,
  normalizeTagName,
  removeTagIdFromSelection,
  type PlayerKey,
  type TagOwnerScope,
} from '@/lib/playerTags';
import {
  assignExistingTagToPlayer,
  createTagAndAssignToPlayer,
  removeTagFromPlayer,
} from '@/lib/playerTagService';

export type TagPickerVariant = 'table' | 'detail';

/** Max visible tag chips in table cells; remainder shown as +N. */
export const TABLE_TAG_VISIBLE_LIMIT = 2;

export interface TagPickerProps {
  /** Owner: pass either academyId OR trainerId (one required). */
  academyId?: string;
  trainerId?: string;
  playerKey: PlayerKey;
  tags: PlayerTag[];
  selectedTagIds: string[];
  onTagsChange: (tags: PlayerTag[]) => void;
  onSelectedTagIdsChange: (tagIds: string[]) => void;
  variant?: TagPickerVariant;
  /** Optional refetch hook (e.g. sync filter dropdown). */
  onChanged?: () => void;
}

function resolveScope(academyId?: string, trainerId?: string): TagOwnerScope | null {
  if (academyId) return { kind: 'academy', academyProfileId: academyId };
  if (trainerId) return { kind: 'trainer', trainerProfileId: trainerId };
  return null;
}

/** Academy/trainer player tag picker with search, assign, and inline create. */
export function TagPicker({
  academyId,
  trainerId,
  playerKey,
  tags,
  selectedTagIds,
  onTagsChange,
  onSelectedTagIdsChange,
  variant = 'table',
  onChanged,
}: TagPickerProps) {
  const scope = resolveScope(academyId, trainerId);
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [localTagIds, setLocalTagIds] = useState<string[]>(selectedTagIds);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLocalTagIds(selectedTagIds);
  }, [selectedTagIds]);

  const selectedTags = useMemo(
    () => tags.filter((tag) => localTagIds.includes(tag.id)),
    [tags, localTagIds],
  );

  const unassignedMatches = useMemo(
    () => getUnassignedTags(tags, localTagIds, query),
    [tags, localTagIds, query],
  );

  const showCreate = canOfferCreateTag(tags, query);

  const applyAssignment = (tagIds: string[], nextTags?: PlayerTag[]) => {
    setLocalTagIds(tagIds);
    onSelectedTagIdsChange(tagIds);
    if (nextTags) onTagsChange(nextTags);
    onChanged?.();
  };

  const handleAssign = async (tagId: string) => {
    if (!scope || busy) return;
    setBusy(true);
    try {
      const result = await assignExistingTagToPlayer(
        supabase,
        scope,
        playerKey,
        tagId,
        localTagIds,
      );
      if (result.error) throw new Error(result.error);
      applyAssignment(result.tagIds);
      setQuery('');
      setOpen(false);
    } catch (err: unknown) {
      logger.error('Error assigning tag', err as Error);
      toast({
        title: t('players.tags.errorTitle', 'Error'),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    if (!scope || busy) return;
    const name = normalizeTagName(query);
    if (!name) return;
    setBusy(true);
    try {
      const result = await createTagAndAssignToPlayer(
        supabase,
        scope,
        playerKey,
        name,
        localTagIds,
        tags,
      );
      if (result.isDuplicate) {
        toast({
          title: t('players.tags.duplicateTitle', 'Tag already exists'),
          description: t(
            'players.tags.duplicateDescription',
            'A tag with this name already exists for this academy.',
          ),
          variant: 'destructive',
        });
        return;
      }
      if (result.error) throw new Error(result.error);
      applyAssignment(result.tagIds, result.catalogTags as PlayerTag[]);
      setQuery('');
      setOpen(false);
    } catch (err: unknown) {
      logger.error('Error creating tag', err as Error);
      toast({
        title: t('players.tags.errorTitle', 'Error'),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (tagId: string) => {
    if (!scope || busy) return;
    const optimistic = removeTagIdFromSelection(localTagIds, tagId);
    setLocalTagIds(optimistic);
    onSelectedTagIdsChange(optimistic);
    setBusy(true);
    try {
      const result = await removeTagFromPlayer(
        supabase,
        scope,
        playerKey,
        tagId,
        selectedTagIds,
      );
      if (result.error) throw new Error(result.error);
      applyAssignment(result.tagIds);
    } catch (err: unknown) {
      setLocalTagIds(selectedTagIds);
      onSelectedTagIdsChange(selectedTagIds);
      logger.error('Error removing tag', err as Error);
      toast({
        title: t('players.tags.errorTitle', 'Error'),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  if (!scope) return null;

  const isTable = variant === 'table';
  const visibleTags = isTable
    ? selectedTags.slice(0, TABLE_TAG_VISIBLE_LIMIT)
    : selectedTags;
  const overflowCount = isTable
    ? Math.max(0, selectedTags.length - TABLE_TAG_VISIBLE_LIMIT)
    : 0;

  const addButtonClass = cn(
    'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 -mx-1 text-left hover:bg-muted/50',
    isTable ? 'h-6 text-xs' : 'min-h-[28px] text-sm',
    selectedTags.length === 0 && 'text-muted-foreground',
  );

  return (
    <div
      className={cn(
        'flex items-center gap-1 min-w-0',
        isTable ? 'flex-nowrap overflow-hidden h-8 max-w-full' : 'flex-wrap gap-1.5',
      )}
      data-testid={isTable ? 'tag-picker-table' : undefined}
    >
      {visibleTags.map((tag) => (
        <Badge
          key={tag.id}
          variant="outline"
          className={cn(
            'h-5 px-1.5 text-[11px] border gap-0.5 pr-0.5 shrink-0',
            isTable && 'max-w-[100px]',
            getTagColorClass(tag.color),
          )}
          title={tag.name}
        >
          <span className={cn(isTable && 'truncate')}>{tag.name}</span>
          <button
            type="button"
            className="rounded-full p-0.5 shrink-0 hover:bg-black/10 dark:hover:bg-white/10"
            aria-label={t('players.tags.remove', 'Remove tag')}
            onClick={(e) => {
              e.stopPropagation();
              void handleRemove(tag.id);
            }}
            disabled={busy}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      {overflowCount > 0 && (
        <Badge
          variant="secondary"
          className="h-5 px-1.5 text-[11px] shrink-0"
          data-testid="tag-picker-overflow-count"
          title={selectedTags
            .slice(TABLE_TAG_VISIBLE_LIMIT)
            .map((tag) => tag.name)
            .join(', ')}
        >
          +{overflowCount}
        </Badge>
      )}

      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className={addButtonClass}
            data-testid="tag-picker-add-button"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin shrink-0" />
            ) : (
              <Plus className="h-3 w-3 shrink-0" />
            )}
            {selectedTags.length === 0
              ? t('players.tags.add', 'Add tag')
              : t('players.tags.addMore', 'Add')}
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-72 p-0"
          align="start"
          onClick={(e) => e.stopPropagation()}
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t('players.tags.searchPlaceholder', 'Search or create tag…')}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="max-h-48">
              {unassignedMatches.length === 0 && !showCreate && (
                <CommandEmpty>
                  {tags.length === 0
                    ? t('players.tags.typeToCreate', 'Type a name to create your first tag')
                    : t('players.tags.noMatches', 'No matching tags')}
                </CommandEmpty>
              )}
              {unassignedMatches.length > 0 && (
                <CommandGroup heading={t('players.tags.existing', 'Tags')}>
                  {unassignedMatches.map((tag) => (
                    <CommandItem
                      key={tag.id}
                      value={tag.name}
                      onSelect={() => void handleAssign(tag.id)}
                      disabled={busy}
                    >
                      <span
                        className={cn(
                          'inline-block h-2 w-2 rounded-full mr-2 shrink-0',
                          getTagColorClass(tag.color)
                            .split(' ')
                            .filter((c) => c.startsWith('bg-'))
                            .join(' '),
                        )}
                      />
                      {tag.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {showCreate && (
                <CommandGroup>
                  <CommandItem
                    value={`__create__${query}`}
                    onSelect={() => void handleCreate()}
                    disabled={busy}
                    className="text-primary"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {t('players.tags.createOption', 'Create "{{name}}"', {
                      name: normalizeTagName(query),
                    })}
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Re-export for pages that append a newly created tag to local catalog only. */
export { appendTagToCatalog };
