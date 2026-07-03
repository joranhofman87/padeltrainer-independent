import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface GenerateProposalsGuardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
  calendarPath: string;
}

export function GenerateProposalsGuard({ open, onOpenChange, onContinue, calendarPath }: GenerateProposalsGuardProps) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  // Re-entry guard: ConfirmDialog does not auto-close, so a double-click on the confirm
  // button before the close commits must not fire onContinue twice (duplicate AI spend).
  const continuedRef = useRef(false);

  useEffect(() => {
    if (open) continuedRef.current = false;
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('proposals.guard.title')}
      description={t('proposals.guard.description')}
      confirmLabel={t('proposals.guard.continue')}
      cancelLabel={t('proposals.guard.goToCalendar')}
      variant="default"
      // Only the explicit "go to calendar" button navigates; Escape just closes
      // (matching the original hand-rolled dialog's semantics exactly).
      onCancel={() => navigate(calendarPath)}
      onConfirm={() => {
        if (continuedRef.current) return;
        continuedRef.current = true;
        // Original order: continue fires first, then the close commits.
        onContinue();
        onOpenChange(false);
      }}
    />
  );
}
