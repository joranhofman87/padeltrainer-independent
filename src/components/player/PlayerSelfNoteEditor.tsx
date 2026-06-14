import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Eye, EyeOff, Trash2, Loader2, NotebookPen } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useCreateSelfNote, useUpdateSelfNote, useDeleteSelfNote } from '@/lib/playerSelfNotes';
import type { OwnNote } from '@/lib/playerJourney';

export function PlayerSelfNoteEditor({
  slotId,
  authorId,
  profileId,
  notes,
}: {
  slotId: string;
  authorId: string;
  profileId: string;
  notes: OwnNote[];
}) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [share, setShare] = useState(false);
  const create = useCreateSelfNote();
  const update = useUpdateSelfNote();
  const remove = useDeleteSelfNote();

  const onSave = () => {
    if (!body.trim()) return;
    create.mutate(
      { slotId, authorId, profileId, visibility: share ? 'shared' : 'private', body: body.trim() },
      {
        onSuccess: () => { setBody(''); setShare(false); },
        onError: (e) => toast({ title: t('selfNotes.saveError', 'Could not save note'), description: String((e as Error).message), variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <NotebookPen className="h-3.5 w-3.5" />
        {t('selfNotes.heading', 'My notes')}
      </p>

      {notes.length > 0 && (
        <ul className="space-y-2">
          {notes.map((n) => {
            const shared = n.visibility === 'shared';
            return (
              <li key={n.id} className="flex items-start gap-2 rounded-md border bg-background p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words">{n.body}</p>
                  <Badge variant={shared ? 'secondary' : 'outline'} className="mt-1 gap-1 text-[10px]">
                    {shared ? <Eye className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
                    {shared ? t('selfNotes.shared', 'Shared with coach') : t('selfNotes.private', 'Private')}
                  </Badge>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    checked={shared}
                    onCheckedChange={(v) => update.mutate({ id: n.id, visibility: v ? 'shared' : 'private' })}
                    aria-label={t('selfNotes.shareToggle', 'Share with my coach')}
                  />
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => remove.mutate(n.id)} aria-label={t('delete', 'Delete')}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('selfNotes.placeholder', 'Add a note for yourself about this session…')}
        rows={2}
        className="text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={share} onCheckedChange={setShare} aria-label={t('selfNotes.shareToggle', 'Share with my coach')} />
          {t('selfNotes.shareToggle', 'Share with my coach')}
        </label>
        <Button size="sm" onClick={onSave} disabled={!body.trim() || create.isPending}>
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('selfNotes.save', 'Save')}
        </Button>
      </div>
    </div>
  );
}
