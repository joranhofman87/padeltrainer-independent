/**
 * Backwards-compatible alias of the shared {@link ConfirmDialog}. New code should import `ConfirmDialog`
 * from `@/components/ui/confirm-dialog` directly; this re-export keeps the existing destructive-delete
 * call sites working unchanged (ConfirmDialog defaults to `variant='destructive'`).
 */
export { ConfirmDialog as ConfirmDeleteDialog, type ConfirmDialogProps } from './confirm-dialog';
