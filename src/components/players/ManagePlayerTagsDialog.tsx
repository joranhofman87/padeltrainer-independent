import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { TAG_COLORS, getTagColorClass, PlayerTag } from './playerTagColors';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';

interface ManagePlayerTagsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owner: pass either academyId OR trainerId (one required). */
  academyId?: string;
  trainerId?: string;
  tags: PlayerTag[];
  onChanged: () => void;
}

export function ManagePlayerTagsDialog({ open, onOpenChange, academyId, trainerId, tags, onChanged }: ManagePlayerTagsDialogProps) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>('blue');
  const [busy, setBusy] = useState(false);

  const ownerCol = academyId ? 'academy_profile_id' : 'trainer_profile_id';
  const ownerId = academyId ?? trainerId;

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || !ownerId) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('academy_player_tags')
        .insert({ [ownerCol]: ownerId, name, color: newColor } as any);
      if (error) throw error;
      setNewName('');
      onChanged();
    } catch (err: any) {
      logger.error('Error creating tag', err);
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      const { error } = await supabase.from('academy_player_tags').delete().eq('id', id);
      if (error) throw error;
      onChanged();
    } catch (err: any) {
      logger.error('Error deleting tag', err);
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const handleColorChange = async (id: string, color: string) => {
    try {
      await supabase.from('academy_player_tags').update({ color }).eq('id', id);
      onChanged();
    } catch (err) {
      logger.error('Error updating tag color', err as Error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('players.tags.manageTitle', 'Manage Player Tags')}</DialogTitle>
          <DialogDescription>
            {t('players.tags.manageDescription', 'Create custom tags to segment your players.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label className="text-xs">{t('players.tags.newTag', 'New tag')}</Label>
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('players.tags.namePlaceholder', 'e.g. VIP, Beginner, Lead')}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              />
              <Button onClick={handleCreate} disabled={busy || !newName.trim()} size="sm">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {TAG_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setNewColor(c.key)}
                  className={cn(
                    'h-6 w-6 rounded-full border-2 transition-all',
                    c.className.split(' ').filter(cls => cls.startsWith('bg-')).join(' '),
                    newColor === c.key ? 'border-foreground scale-110' : 'border-transparent'
                  )}
                  aria-label={c.key}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {tags.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                {t('players.tags.empty', 'No tags yet. Create one above.')}
              </p>
            ) : tags.map((tag) => (
              <div key={tag.id} className="flex items-center justify-between gap-2 p-2 rounded-md border">
                <Badge variant="outline" className={cn('border', getTagColorClass(tag.color))}>
                  {tag.name}
                </Badge>
                <div className="flex items-center gap-1">
                  {TAG_COLORS.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => handleColorChange(tag.id, c.key)}
                      className={cn(
                        'h-4 w-4 rounded-full border',
                        c.className.split(' ').filter(cls => cls.startsWith('bg-')).join(' '),
                        tag.color === c.key ? 'border-foreground' : 'border-transparent'
                      )}
                      aria-label={c.key}
                    />
                  ))}
                  <Button
                    variant="ghost"
                    size="icon" aria-label="Delete"
                    className="h-7 w-7 ml-1 text-destructive"
                    onClick={() => handleDelete(tag.id)}
                    disabled={busy}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
