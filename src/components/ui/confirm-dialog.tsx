import { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
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

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass already-translated strings; this component owns no i18n namespace. */
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  /** Does NOT auto-close: callers close via onOpenChange/state once the action settles. */
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
  /** 'destructive' (default) styles the confirm button red; 'default' uses the primary button. */
  variant?: 'default' | 'destructive';
  /** Extra content rendered between the description and the footer (e.g. a checkbox, an impact list). */
  children?: ReactNode;
  /** Disables the confirm button (e.g. a type-to-confirm gate). */
  confirmDisabled?: boolean;
  /** `data-testid` for the confirm button (some call sites assert on it). */
  confirmTestId?: string;
}

/**
 * Controlled confirm AlertDialog — the shared shell for the app's confirm/destructive dialogs.
 * The caller owns close (it stays open while `loading` so async actions can run in flight) and passes
 * already-translated labels. `variant='destructive'` (default) styles the confirm button red; pass
 * `variant='default'` for a non-destructive confirm. Use `children` for an extra body (a checkbox, an
 * impact list) and `confirmDisabled` for a gated confirm.
 *
 * `ConfirmDeleteDialog` (in ./confirm-delete-dialog) is a backwards-compatible alias of this component.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  loading = false,
  variant = 'destructive',
  children,
  confirmDisabled = false,
  confirmTestId,
}: ConfirmDialogProps) {
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
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            data-testid={confirmTestId}
            disabled={loading || confirmDisabled}
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
            className={cn(
              variant === 'destructive' && 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
            )}
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
