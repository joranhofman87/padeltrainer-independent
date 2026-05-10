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

interface PlayerNotesCellProps {
  academyId: string;
  playerKey: { guest_player_id: string | null; profile_id: string | null };
  notes: string;
  onChanged: () => void;
}

export function PlayerNotesCell({ academyId, playerKey, notes, onChanged }: PlayerNotesCellProps) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [localNotes, setLocalNotes] = useState(notes);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setLocalNotes(notes); }, [notes]);

  const persist = async () => {
    if (localNotes === notes) return;
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
            academy_profile_id: academyId,
            guest_player_id: playerKey.guest_player_id,
            profile_id: playerKey.profile_id,
            notes: trimmed,
          } as any);
        if (error) throw error;
      }
      onChanged();
    } catch (err: any) {
      logger.error('Error saving notes', err);
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const preview = (notes || '').trim();

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) persist(); }}>
      <PopoverTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className="flex items-start gap-1 min-h-[24px] hover:bg-muted/50 rounded px-1 -mx-1 w-full text-left text-xs text-muted-foreground"
        >
          <StickyNote className="h-3 w-3 mt-0.5 shrink-0" />
          {preview ? (
            <span className="line-clamp-2">{preview}</span>
          ) : (
            <span>{t('players.notes.add', 'Add note')}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3 space-y-2" align="start" onClick={(e) => e.stopPropagation()}>
        <Label className="text-xs flex items-center justify-between">
          {t('players.notes.label', 'Internal notes')}
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
        </Label>
        <Textarea
          value={localNotes}
          onChange={(e) => setLocalNotes(e.target.value)}
          rows={5}
          placeholder={t('players.notes.placeholder', 'Internal notes about this player...')}
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
