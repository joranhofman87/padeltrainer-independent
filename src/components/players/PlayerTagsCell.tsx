import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Check, Plus, Loader2 } from 'lucide-react';
import { getTagColorClass, PlayerTag } from './playerTagColors';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';

interface PlayerTagsCellProps {
  academyId: string;
  playerKey: { guest_player_id: string | null; profile_id: string | null };
  tags: PlayerTag[];
  selectedTagIds: string[];
  onChanged: () => void;
}

export function PlayerTagsCell({ academyId, playerKey, tags, selectedTagIds, onChanged }: PlayerTagsCellProps) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [localTagIds, setLocalTagIds] = useState<string[]>(selectedTagIds);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setLocalTagIds(selectedTagIds); }, [selectedTagIds]);

  const selectedTags = tags.filter(tag => selectedTagIds.includes(tag.id));

  const persist = async (tagIds: string[]) => {
    if (!playerKey.guest_player_id && !playerKey.profile_id) return;
    setBusy(true);
    try {
      const baseQuery = supabase
        .from('academy_player_metadata')
        .select('id')
        .eq('academy_profile_id', academyId);

      const { data: existing } = await (playerKey.guest_player_id
        ? baseQuery.eq('guest_player_id', playerKey.guest_player_id)
        : baseQuery.eq('profile_id', playerKey.profile_id!)
      ).maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from('academy_player_metadata')
          .update({ tag_ids: tagIds })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('academy_player_metadata')
          .insert({
            academy_profile_id: academyId,
            guest_player_id: playerKey.guest_player_id,
            profile_id: playerKey.profile_id,
            tag_ids: tagIds,
          } as any);
        if (error) throw error;
      }
      onChanged();
    } catch (err: any) {
      logger.error('Error saving player tags', err);
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const toggleTag = (tagId: string) => {
    const next = localTagIds.includes(tagId)
      ? localTagIds.filter(id => id !== tagId)
      : [...localTagIds, tagId];
    setLocalTagIds(next);
    persist(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className="flex flex-wrap gap-1 items-center min-h-[24px] hover:bg-muted/50 rounded px-1 -mx-1 w-full text-left"
        >
          {selectedTags.length === 0 ? (
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Plus className="h-3 w-3" /> {t('players.tags.add', 'Add')}
            </span>
          ) : (
            selectedTags.map(tag => (
              <Badge key={tag.id} variant="outline" className={cn('h-5 px-1.5 text-[11px] border', getTagColorClass(tag.color))}>
                {tag.name}
              </Badge>
            ))
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3 space-y-3" align="start" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center justify-between">
            {t('players.tags.label', 'Tags')}
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          </Label>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {tags.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('players.tags.noneCreated', 'No tags created yet')}</p>
            ) : tags.map(tag => {
              const isSelected = localTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleTag(tag.id)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition',
                    getTagColorClass(tag.color),
                    !isSelected && 'opacity-50 hover:opacity-100',
                  )}
                >
                  {isSelected && <Check className="h-3 w-3" />}
                  {tag.name}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
