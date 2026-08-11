import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Eye, EyeOff, Trash2, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  useCreateCoachingNote,
  useUpdateCoachingNote,
  useDeleteCoachingNote,
  type CoachingNote,
  type NoteAuthorRole,
} from '@/lib/coachingNotes';

export function PlayerCoachingNoteEditor({
  slotId,
  authorId,
  authorRole,
  subjectProfileId,
  subjectGuestPlayerId,
  subjectName,
  isGuest,
  notes,
}: {
  slotId: string;
  authorId: string;
  authorRole: NoteAuthorRole;
  subjectProfileId: string | null;
  subjectGuestPlayerId: string | null;
  subjectName: string;
  // PERSON-LEVEL "has no login" (Phase 3.5c: callers pass isGuestForBadge, NOT the seat kind) —
  // gates note sharing; a seat-based value would hide the share toggle for merged login holders.
  isGuest: boolean;
  notes: CoachingNote[];
}) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [share, setShare] = useState(false);
  const create = useCreateCoachingNote();
  const update = useUpdateCoachingNote(slotId);
  const remove = useDeleteCoachingNote(slotId);

  const myNotes = notes.filter(
    (n) =>
      (subjectProfileId && n.subject_profile_id === subjectProfileId) ||
      (subjectGuestPlayerId && n.subject_guest_player_id === subjectGuestPlayerId),
  );

  const onSave = () => {
    if (!body.trim()) return;
    create.mutate(
      {
        slotId,
        authorId,
        authorRole,
        subjectProfileId,
        subjectGuestPlayerId,
        // person has no login, so a shared note would be unreadable → always private
        visibility: !isGuest && share ? 'shared' : 'private',
        body: body.trim(),
      },
      {
        onSuccess: () => { setBody(''); setShare(false); },
        onError: (e) => toast({ title: t('coachingNotes.saveError', 'Could not save note'), description: String((e as Error).message), variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      {myNotes.length > 0 && (
        <ul className="space-y-2">
          {myNotes.map((n) => {
            const mine = n.author_id === authorId;
            const shared = n.visibility === 'shared';
            return (
              <li key={n.id} className="flex items-start gap-2 rounded-md border bg-background p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words">{n.body}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant={shared ? 'secondary' : 'outline'} className="gap-1 text-[10px]">
                      {shared ? <Eye className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
                      {shared ? t('coachingNotes.shared', 'Shared') : t('coachingNotes.private', 'Private draft')}
                    </Badge>
                    {n.author_role === 'academy' && authorRole === 'trainer' && (
                      <span className="text-[10px] text-muted-foreground">{t('coachingNotes.byAcademy', 'by academy')}</span>
                    )}
                  </div>
                </div>
                {mine && (
                  <div className="flex shrink-0 items-center gap-1">
                    {!isGuest && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center">
                            <Switch
                              checked={shared}
                              onCheckedChange={(v) => update.mutate({ id: n.id, visibility: v ? 'shared' : 'private' })}
                              aria-label={t('coachingNotes.toggleShare', 'Share with player')}
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{t('coachingNotes.toggleShare', 'Share with player')}</TooltipContent>
                      </Tooltip>
                    )}
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => remove.mutate(n.id)} aria-label={t('delete', 'Delete')}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('coachingNotes.placeholder', 'Add a coaching note for {{name}}…', { name: subjectName })}
        rows={2}
        className="text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        {isGuest ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={false} disabled aria-label={t('coachingNotes.shareWithPlayer', 'Share with player')} />
                {t('coachingNotes.shareWithPlayer', 'Share with player')}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('coachingNotes.guestNoShare', 'Guest players have no login to view notes')}</TooltipContent>
          </Tooltip>
        ) : (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={share} onCheckedChange={setShare} aria-label={t('coachingNotes.shareWithPlayer', 'Share with player')} />
            {t('coachingNotes.shareWithPlayer', 'Share with player')}
          </label>
        )}
        <Button size="sm" onClick={onSave} disabled={!body.trim() || create.isPending}>
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('coachingNotes.save', 'Save note')}
        </Button>
      </div>
    </div>
  );
}
