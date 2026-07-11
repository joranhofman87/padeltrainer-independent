import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { getRebookRoundExtendPrefill } from '@/lib/rebookRoundExtend';
import { saveRebookRoundTexts, type RebookRoundTexts } from '@/lib/rebookRoundTexts';
import { normalizeRichTextHtml } from '@/lib/richText';
import { EmailMessageField } from '@/components/email/EmailMessageField';
import { EmailSubjectField } from '@/components/email/EmailSubjectField';
import { RebookRulesField } from '@/components/cycles/RebookRulesField';
import { RebookClaimInfoField } from '@/components/cycles/RebookClaimInfoField';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  academyProfileId: string;
  roundId: string;
  onSaved?: () => void;
}

/**
 * Edit a rebook round's TEXTS after it was sent: claim-page explanation, invitation email
 * (future resume-sends), automated-reminder email, and the rebooking rules. Saves the keys
 * onto EVERY cycle of the round; the claim page + rules change immediately (read live via the
 * token RPC), emails only affect sends that happen after the save.
 */
export function RebookRoundTextsDialog({ open, onOpenChange, academyProfileId, roundId, onSaved }: Props) {
  const { t } = useTranslation('cycles');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cycleIds, setCycleIds] = useState<string[]>([]);
  const [texts, setTexts] = useState<RebookRoundTexts>({
    claimInfo: '', invitationSubject: '', invitationMessage: '', reminderSubject: '', reminderMessage: '', rebookRules: '',
  });
  const set = (key: keyof RebookRoundTexts) => (value: string) => setTexts((cur) => ({ ...cur, [key]: value }));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    getRebookRoundExtendPrefill(academyProfileId, roundId)
      .then((prefill) => {
        if (cancelled) return;
        if (!prefill) {
          toast.error(t('rebookTexts.errNotFound', 'Deze ronde is niet gevonden.'));
          onOpenChange(false);
          return;
        }
        setCycleIds(prefill.cycleIds);
        setTexts({
          claimInfo: prefill.claimInfo,
          invitationSubject: prefill.invitationSubject,
          invitationMessage: prefill.invitationMessage,
          reminderSubject: prefill.reminderSubject,
          reminderMessage: prefill.reminderMessage,
          rebookRules: prefill.rebookRules,
        });
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(getFriendlyErrorMessage(e, t('rebookTexts.errLoad', 'Kon de teksten niet laden. Probeer het opnieuw.')));
          onOpenChange(false);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, academyProfileId, roundId]);

  const onSave = async () => {
    if (saving || loading) return;
    setSaving(true);
    try {
      const res = await saveRebookRoundTexts(cycleIds, {
        ...texts,
        rebookRules: normalizeRichTextHtml(texts.rebookRules) ?? '',
      });
      if (res.failed.length > 0) {
        // Partial write = different texts per group; keep the dialog open so a retry can finish the job.
        toast.error(t('rebookTexts.partialFail', '{{failed}} van de {{total}} groepen konden niet worden bijgewerkt. Probeer opnieuw op te slaan.', {
          failed: res.failed.length, total: cycleIds.length,
        }));
        return;
      }
      toast.success(t('rebookTexts.saved', 'Teksten opgeslagen voor de hele ronde.'));
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookTexts.errSave', 'Opslaan mislukt. Probeer het opnieuw.')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('rebookTexts.title', 'Teksten van de ronde bewerken')}</DialogTitle>
          <DialogDescription>
            {t('rebookTexts.description', 'Geldt voor alle groepen in deze ronde. De bevestigingspagina en regels veranderen direct; e-mailteksten gelden voor uitnodigingen en herinneringen die hierna nog verstuurd worden — al verzonden e-mails veranderen niet.')}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border p-3">
              <RebookClaimInfoField
                id="round-texts-claim-info"
                value={texts.claimInfo}
                onChange={set('claimInfo')}
                disabled={saving}
              />
            </div>
            <div className="space-y-3 rounded-md border p-3">
              <EmailSubjectField
                id="round-texts-invite-subject"
                value={texts.invitationSubject}
                onChange={set('invitationSubject')}
                disabled={saving}
                label={t('rebookCohort.inviteSubjectLabel', 'Onderwerp van de uitnodiging (optioneel)')}
                placeholder={t('rebookCohort.inviteSubjectPlaceholder', 'Reserveer je plek voor de volgende cyclus')}
                variablesHelp={t('rebookCohort.inviteVariablesHelp', 'Voeg variabele toe:')}
              />
              <EmailMessageField
                id="round-texts-invite-message"
                value={texts.invitationMessage}
                onChange={set('invitationMessage')}
                disabled={saving}
                maxLength={2000}
                label={t('rebookCohort.inviteMessageLabel', 'Persoonlijk bericht in de uitnodiging (optioneel)')}
                placeholder={t('rebookCohort.inviteMessagePlaceholder', 'Bijv. Leuk dat je er weer bij bent! Bevestig hieronder je vaste plek voor de volgende ronde.')}
                variablesHelp={t('rebookCohort.inviteVariablesHelp', 'Voeg variabele toe:')}
              />
            </div>
            <div className="space-y-3 rounded-md border p-3">
              <EmailSubjectField
                id="round-texts-reminder-subject"
                value={texts.reminderSubject}
                onChange={set('reminderSubject')}
                disabled={saving}
                label={t('rebookShared.reminderSubjectLabel', 'Onderwerp van de herinnering')}
                placeholder={t('rebookShared.defaultReminderSubject', 'Herinnering: bevestig je plek')}
                variablesHelp={t('rebookCohort.inviteVariablesHelp', 'Voeg variabele toe:')}
              />
              <EmailMessageField
                id="round-texts-reminder-message"
                value={texts.reminderMessage}
                onChange={set('reminderMessage')}
                disabled={saving}
                maxLength={2000}
                label={t('rebookShared.reminderMessageLabel', 'Bericht in de herinnering')}
                placeholder={t('rebookShared.defaultReminderMessage', '')}
                variablesHelp={t('rebookCohort.inviteVariablesHelp', 'Voeg variabele toe:')}
              />
            </div>
            <div className="rounded-md border p-3">
              <RebookRulesField
                academyProfileId={academyProfileId}
                value={texts.rebookRules}
                onChange={set('rebookRules')}
                disabled={saving}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:cancel', 'Annuleren')}
          </Button>
          <Button onClick={onSave} disabled={saving || loading}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {saving ? t('common:saving', 'Bezig...') : t('rebookTexts.save', 'Opslaan voor hele ronde')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
