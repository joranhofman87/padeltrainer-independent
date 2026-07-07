import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { StickyNote, Loader2 } from 'lucide-react';
import { logger } from '@/lib/logger';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';

interface PlayerNotesCellProps {
  /** Owner: pass either academyId OR trainerId (one required). */
  academyId?: string;
  trainerId?: string;
  playerKey: { guest_player_id: string | null; profile_id: string | null };
  notes: string;
  onChanged: () => void;
  /** View-only: render the note text without the edit popover. */
  readOnly?: boolean;
}

export function PlayerNotesCell({ academyId, trainerId, playerKey, notes, onChanged, readOnly }: PlayerNotesCellProps) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [localNotes, setLocalNotes] = useState(notes);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setLocalNotes(notes); }, [notes]);

  const ownerCol = academyId ? 'academy_profile_id' : 'trainer_profile_id';
  const ownerId = academyId ?? trainerId;

  const persist = async () => {
    if (localNotes === notes) return;
    if (!playerKey.guest_player_id && !playerKey.profile_id) return;
    if (!ownerId) return;
    setBusy(true);
    try {
      const baseQuery = supabase
        .from('academy_player_metadata')
        .select('id')
        .eq(ownerCol, ownerId);

      const { data: existing } = await (playerKey.guest_player_id
        ? baseQuery.eq('guest_player_id', playerKey.guest_player_id)
        : baseQuery.eq('profile_id', playerKey.profile_id!)
      ).maybeSingle();

      const trimmed = localNotes.trim() || null;
      if (existing) {
        const { error } = await supabase
          .from('academy_player_metadata')
          .update({ notes: trimmed })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('academy_player_metadata')
          .insert({
            [ownerCol]: ownerId,
            guest_player_id: playerKey.guest_player_id,
            profile_id: playerKey.profile_id,
            notes: trimmed,
          } as any);
        if (error) throw error;
      }
      onChanged();
    } catch (err: any) {
      logger.error('Error saving notes', err);
      toast({ title: 'Error', description: getFriendlyErrorMessage(err, t('players.notesSaveError', 'Failed to save the note. Please try again.')), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const preview = (notes || '').trim();

  if (readOnly) {
    return (
      <span className="flex h-8 min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground" title={preview || undefined}>
        <StickyNote className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">{preview || '—'}</span>
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) persist(); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="flex h-8 min-w-0 max-w-full items-center gap-1 overflow-hidden rounded px-1 -mx-1 text-left text-xs text-muted-foreground hover:bg-muted/50 whitespace-nowrap"
          data-testid="player-notes-cell-trigger"
          title={preview || undefined}
        >
          <StickyNote className="h-3 w-3 shrink-0" />
          {preview ? (
            <span className="min-w-0 truncate">{preview}</span>
          ) : (
            <span className="shrink-0">{t('players.notesAdd', 'Add note')}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3 space-y-2" align="start" onClick={(e) => e.stopPropagation()}>
        <Label className="text-xs flex items-center justify-between">
          {t('players.notesLabel', 'Internal notes')}
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
        </Label>
        <Textarea
          value={localNotes}
          onChange={(e) => setLocalNotes(e.target.value)}
          rows={5}
          placeholder={t('players.notesPlaceholder', 'Internal notes about this player...')}
          className="text-sm"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={() => { persist(); setOpen(false); }} disabled={busy}>
            {t('common.save', 'Save')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
