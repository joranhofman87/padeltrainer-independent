import { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass already-translated strings; this component owns no i18n namespace. */
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  /** Does not auto-close: callers close via onOpenChange/state once the action settles. */
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

/**
 * Destructive-confirm AlertDialog for permanent one-click deletes.
 * Controlled by the caller so async deletes can keep it open while in flight.
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  loading = false,
}: ConfirmDeleteDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!loading) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={loading}
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
