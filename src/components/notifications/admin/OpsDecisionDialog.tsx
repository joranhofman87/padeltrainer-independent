import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Textarea } from '@/components/ui/textarea';
import type { OpsDecision } from './useOpsDecision';

/**
 * The one confirmation dialog every N4 operational decision uses. It COMPOSES the app's
 * canonical `ConfirmDialog` — which already blocks dismissal and disables Cancel while a
 * submit is in flight (an operator cancelling mid-flight and opening a second decision was a
 * real hazard: the first handler could then close the second dialog) — and adds only what is
 * specific to these decisions: the mandatory reason, frozen after the first submit, and the
 * identity line the confirmation is bound to.
 */
export function OpsDecisionDialog<T>({
  decision,
  title,
  description,
  confirmLabel,
  busyLabel,
  destructive,
  reasonPlaceholder,
  testId,
}: {
  /** The decision this dialog IS: it supplies open-ness, the frozen reason, busy and confirm.
   *  Passing the object rather than eight derived props is what keeps the page an orchestrator —
   *  and makes it impossible to wire a dialog to one decision's reason and another's confirm. */
  decision: OpsDecision<T> & { confirm: () => void };
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  destructive?: boolean;
  reasonPlaceholder?: string;
  testId: string;
}) {
  const { t } = useTranslation('admin');
  // shared copy: the same two sentences for every decision, so the component owns them
  const cancelLabel = t('cancel', 'Cancel');
  const frozenNote = t('notifOps.frozenNote', 'The decision is locked to this exact wording — a retry replays it. To decide differently, cancel and start a new decision.');
  const { target, reason, setReason, frozen, busy, close, confirm } = decision;
  const open = target !== null;
  const onCancel = close;
  const onConfirm = confirm;
  const onReasonChange = setReason;
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
