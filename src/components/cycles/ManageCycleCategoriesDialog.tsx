import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { TAG_COLORS, getTagColorClass } from '@/components/players/playerTagColors';
import { cn } from '@/lib/utils';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import {
  createCycleCategory, deleteCycleCategory, updateCycleCategory, type CycleCategory,
} from '@/lib/cycleCategories';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  academyId: string;
  categories: CycleCategory[];
  onChanged: () => void;
}

/** Manage the academy's cycle-category catalog: create (name + palette color), recolor, delete.
 *  Deleting a category un-categorizes its cycles (FK ON DELETE SET NULL). Mirrors
 *  ManagePlayerTagsDialog. */
export function ManageCycleCategoriesDialog({ open, onOpenChange, academyId, categories, onChanged }: Props) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>('blue');
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<CycleCategory | null>(null);

  const fail = (err: unknown) => {
    const msg = err instanceof Error && err.message === 'duplicate'
      ? t('cyclesTab.category.duplicate', { defaultValue: 'Er bestaat al een categorie met deze naam.' })
      : getFriendlyErrorMessage(err, t('cyclesTab.category.saveError', { defaultValue: 'Kon de categorie niet opslaan.' }));
    toast({ title: 'Error', description: msg, variant: 'destructive' });
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try { await createCycleCategory(academyId, name, newColor); setNewName(''); onChanged(); }
    catch (err) { fail(err); }
    finally { setBusy(false); }
  };
  const handleColor = async (id: string, color: string) => {
    try { await updateCycleCategory(id, { color }); onChanged(); } catch (err) { fail(err); }
  };
  const handleDelete = async (id: string) => {
    setBusy(true);
    try { await deleteCycleCategory(id); onChanged(); }
    catch (err) { fail(err); }
    finally { setBusy(false); setToDelete(null); }
  };

  const swatch = (c: (typeof TAG_COLORS)[number]) => c.className.split(' ').filter((cls) => cls.startsWith('bg-')).join(' ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('cyclesTab.category.manageTitle', { defaultValue: 'Categorieën beheren' })}</DialogTitle>
          <DialogDescription>
            {t('cyclesTab.category.manageDescription', { defaultValue: 'Maak eigen categorieën (bijv. Jeugd, Zomer, Competitie) om je cycli te ordenen.' })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label className="text-xs">{t('cyclesTab.category.newCategory', { defaultValue: 'Nieuwe categorie' })}</Label>
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('cyclesTab.category.namePlaceholder', { defaultValue: 'bijv. Jeugd, Zomer, Competitie' })}
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
                  className={cn('h-6 w-6 rounded-full border-2 transition-all', swatch(c),
                    newColor === c.key ? 'border-foreground scale-110' : 'border-transparent')}
                  aria-label={c.key}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {categories.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                {t('cyclesTab.category.empty', { defaultValue: 'Nog geen categorieën. Maak er hierboven één aan.' })}
              </p>
            ) : categories.map((cat) => (
              <div key={cat.id} className="flex items-center justify-between gap-2 p-2 rounded-md border">
                <Badge variant="outline" className={cn('border', getTagColorClass(cat.color))}>{cat.name}</Badge>
                <div className="flex items-center gap-1">
                  {TAG_COLORS.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => handleColor(cat.id, c.key)}
                      className={cn('h-4 w-4 rounded-full border', swatch(c),
                        cat.color === c.key ? 'border-foreground' : 'border-transparent')}
                      aria-label={c.key}
                    />
                  ))}
                  <Button
                    variant="ghost"
                    size="icon" aria-label="Delete"
                    className="h-7 w-7 ml-1 text-destructive"
                    onClick={() => setToDelete(cat)}
                    disabled={busy}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <ConfirmDeleteDialog
          open={!!toDelete}
          onOpenChange={(next) => { if (!next) setToDelete(null); }}
          title={t('cyclesTab.category.deleteConfirmTitle', { defaultValue: 'Categorie verwijderen?' })}
          description={t('cyclesTab.category.deleteConfirmDescription',
            { defaultValue: 'Dit verwijdert "{{name}}" en haalt de categorie van alle cycli. Dit kan niet ongedaan worden gemaakt.', name: toDelete?.name ?? '' })}
          confirmLabel={t('cyclesTab.category.deleteConfirmAction', { defaultValue: 'Verwijderen' })}
          cancelLabel={t('common:cancel', 'Annuleren')}
          loading={busy}
          onConfirm={() => { if (toDelete) void handleDelete(toDelete.id); }}
        />
      </DialogContent>
    </Dialog>
  );
}
