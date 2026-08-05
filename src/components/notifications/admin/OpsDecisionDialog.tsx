import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * The one confirmation dialog every N4 operational decision uses. It is a single component
 * because all four decisions share the SAME contract (mandatory reason ≥3 chars, inputs frozen
 * after the first submit, one request id replayed on retry) — the only differences are copy and
 * the identity line, which are props. Genuinely different workflows keep their own dialogs.
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
  testId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription data-testid={`${testId}-identity`}>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          readOnly={frozen}
          data-testid={`${testId}-reason`}
        />
        {frozen && (
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-frozen-note`}>{frozenNote}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{cancelLabel}</Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={busy || reason.trim().length < 3}
            data-testid={`${testId}-confirm`}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
