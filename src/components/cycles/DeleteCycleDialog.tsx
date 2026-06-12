import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { type Cycle, getIntakeRequestCounts, deleteCycle } from '@/lib/cycles';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { logger } from '@/lib/logger';

interface DeleteCycleDialogProps {
  cycle: Cycle | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}

/**
 * Destructive confirm for deleting a cycle/registration. The DB cascades
 * intake_requests away on delete (migration 20260123104639), so the dialog
 * fetches the registration count first and warns the trainer about exactly
 * what disappears. Confirm stays disabled until the count is known.
 */
export default function DeleteCycleDialog({ cycle, open, onOpenChange, onDeleted }: DeleteCycleDialogProps) {
  const { t } = useTranslation('cycles');
  // null = unknown (loading or fetch failed) — keep the strong warning in that case
  const [registrationCount, setRegistrationCount] = useState<number | null>(null);
  const [isCountLoading, setIsCountLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const cycleId = open ? cycle?.id : undefined;

  useEffect(() => {
    if (!cycleId) return;
    let cancelled = false;
    setRegistrationCount(null);
    setIsCountLoading(true);
    getIntakeRequestCounts(cycleId)
      .then((counts) => {
        if (!cancelled) setRegistrationCount(counts.total || 0);
      })
      .catch((error: unknown) => {
        logger.error('Error loading registration count for delete confirm', error instanceof Error ? error : new Error(String(error)), { component: 'DeleteCycleDialog' });
      })
      .finally(() => {
        if (!cancelled) setIsCountLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cycleId]);

  const isRegistration = cycle?.type === 'registration';

  const handleConfirm = async () => {
    if (!cycle) return;
    setIsDeleting(true);
    try {
      await deleteCycle(cycle.id);
      toast.success(t('common:deleted', 'Verwijderd'));
      onOpenChange(false);
      onDeleted();
    } catch (error) {
      toast.error(getFriendlyErrorMessage(error, t('deleteDialog.error', 'Verwijderen is niet gelukt. Probeer het opnieuw.')));
    } finally {
      setIsDeleting(false);
    }
  };

  const description = isCountLoading
    ? t('deleteDialog.checkingRegistrations', 'Aanmeldingen controleren...')
    : registrationCount === null
      ? t('deleteDialog.unknownRegistrations', 'Het aantal aanmeldingen kon niet worden opgehaald. Alle bijbehorende spelersaanmeldingen worden ook definitief verwijderd. Dit kan niet ongedaan worden gemaakt.')
      : registrationCount === 0
        ? t('deleteDialog.noRegistrations', 'Er zijn geen aanmeldingen. Deze actie kan niet ongedaan worden gemaakt.')
        : t('deleteDialog.withRegistrations', {
            count: registrationCount,
            defaultValue_one: 'Let op: er is {{count}} spelersaanmelding. Die wordt definitief mee verwijderd — inclusief naam, e-mailadres en voorkeuren. Dit kan niet ongedaan worden gemaakt.',
            defaultValue_other: 'Let op: er zijn {{count}} spelersaanmeldingen. Die worden definitief mee verwijderd — inclusief namen, e-mailadressen en voorkeuren. Dit kan niet ongedaan worden gemaakt.',
          });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!isDeleting) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isRegistration
              ? t('deleteDialog.titleRegistration', 'Inschrijving verwijderen?')
              : t('deleteDialog.titleCycle', 'Cyclus verwijderen?')}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{t('common:cancel', 'Annuleren')}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isDeleting || isCountLoading}
          >
            {isDeleting
              ? t('deleteDialog.deleting', 'Verwijderen...')
              : t('deleteDialog.confirm', 'Definitief verwijderen')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
