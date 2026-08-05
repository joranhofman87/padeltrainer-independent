import type { ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Textarea } from '@/components/ui/textarea';

/**
 * The one confirmation dialog every N4 operational decision uses. It COMPOSES the app's
 * canonical `ConfirmDialog` — which already blocks dismissal and disables Cancel while a
 * submit is in flight (an operator cancelling mid-flight and opening a second decision was a
 * real hazard: the first handler could then close the second dialog) — and adds only what is
 * specific to these decisions: the mandatory reason, frozen after the first submit, and the
 * identity line the confirmation is bound to.
 */
export function OpsDecisionDialog({
  open,
  title,
  description,
  reason,
  onReasonChange,
  frozen,
  busy,
  confirmLabel,
  busyLabel,
  destructive,
  cancelLabel,
  frozenNote,
  reasonPlaceholder,
  testId,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  reason: string;
  onReasonChange: (v: string) => void;
  frozen: boolean;
  busy: boolean;
  confirmLabel: string;
  busyLabel: string;
  destructive?: boolean;
  cancelLabel: string;
  frozenNote: string;
  reasonPlaceholder?: string;
  testId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => { if (!next) onCancel(); }}
      title={title}
      description={<span data-testid={`${testId}-identity`}>{description}</span>}
      confirmLabel={busy ? busyLabel : confirmLabel}
      cancelLabel={cancelLabel}
      variant={destructive ? 'destructive' : 'default'}
      loading={busy}
      confirmDisabled={reason.trim().length < 3}
      confirmTestId={`${testId}-confirm`}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <Textarea
        value={reason}
        onChange={(e) => onReasonChange(e.target.value)}
        readOnly={frozen}
        placeholder={reasonPlaceholder}
        data-testid={`${testId}-reason`}
      />
      {frozen && (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-frozen-note`}>{frozenNote}</p>
      )}
    </ConfirmDialog>
  );
}
