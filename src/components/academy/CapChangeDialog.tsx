import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';

/**
 * N3 M6 — the reason-and-confirm step every academy cap change must pass through.
 *
 * Extracted from the controls page so the submission contract is directly testable (Radix
 * Select internals cannot be operated under jsdom): the mandatory ≥3-char reason, and the
 * client-generated uuid request_id — which is what lets an exact network retry REPLAY on the
 * server instead of double-auditing (the RPC's idempotency is keyed on it).
 */

export type PendingCapChange = { event: string; channel: string; next: 'inherit' | 'daily' | 'weekly' | 'off' };

export function CapChangeDialog({
  pending,
  academyId,
  eventLabel,
  onClose,
  onSaved,
}: {
  pending: PendingCapChange | null;
  academyId: string;
  eventLabel: (key: string) => string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const close = () => {
    setReason('');
    onClose();
  };

  const confirm = async () => {
    if (!pending) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('set_academy_notification_restriction', {
        p_academy_profile_id: academyId,
        p_event_type: pending.event,
        p_channel: pending.channel,
        p_max_frequency: pending.next === 'inherit' ? null : pending.next,
        p_reason: reason.trim(),
        // client-generated so an exact network retry replays instead of double-auditing
        p_request_id: crypto.randomUUID(),
      });
      if (error) throw error;
      toast({ title: t('academyNotifControls.saved', 'Notification cap updated'), description: String(data) });
      setReason('');
      await onSaved();
      onClose();
    } catch (error) {
      logger.error('Failed to set academy notification cap', undefined, { error });
      toast({ title: t('academyNotifControls.saveError', 'Could not update the cap'), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!pending} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {pending
              ? t('academyNotifControls.reasonTitleFor', {
                  defaultValue: 'Why change {{event}}?',
                  event: eventLabel(pending.event),
                })
              : t('academyNotifControls.reasonTitle', 'Why this change?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'academyNotifControls.reasonDesc',
              'A short reason is required. It is stored in the audit log and shown to affected players.',
            )}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('academyNotifControls.reasonPlaceholder', 'e.g. Too many reminder emails during the tournament week')}
          data-testid="cap-reason-input"
        />
        <DialogFooter>
          <Button variant="outline" onClick={close}>{t('cancel', 'Cancel')}</Button>
          <Button onClick={() => void confirm()} disabled={saving || reason.trim().length < 3} data-testid="cap-confirm">
            {saving ? t('academyNotifControls.saving', 'Saving…') : t('academyNotifControls.confirm', 'Apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
