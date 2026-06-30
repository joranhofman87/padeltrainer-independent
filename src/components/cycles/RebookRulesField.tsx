import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { isBlankRichTextHtml } from '@/lib/richText';
import { getAcademyRebookRulesDefault, saveAcademyRebookRulesDefault } from '@/lib/rebookRules';

interface RebookRulesFieldProps {
  academyProfileId: string;
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}

/**
 * Shared "rebooking rules" editor used by BOTH rebook wizards (AcademyNewRoundWizard +
 * RebookCohortWizard) so the two entry points never diverge. Rich text via the reusable
 * RichTextEditor + a "Save as default" button that persists to academy_profiles.rebook_rules. On
 * mount it pre-fills an empty field from the academy default, so each round starts from the saved
 * rules.
 *
 * These rules are the text the player must CONSENT to on the claim/pay page — deliberately separate
 * from the free-text invitation message that appears in the email above the buttons.
 */
export function RebookRulesField({ academyProfileId, value, onChange, disabled }: RebookRulesFieldProps) {
  const { t } = useTranslation('cycles');
  const { toast } = useToast();
  const [savingDefault, setSavingDefault] = useState(false);

  // Refs so the "seed from academy default" effect runs once per academy (on mount) without
  // re-fetching on every keystroke — it reads the latest value/onChange without depending on them.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    getAcademyRebookRulesDefault(academyProfileId).then((def) => {
      if (cancelled || !def) return;
      // Only seed when the round hasn't already got rules — never clobber an in-progress edit.
      if (isBlankRichTextHtml(valueRef.current)) onChangeRef.current(def);
    });
    return () => {
      cancelled = true;
    };
  }, [academyProfileId]);

  const handleSaveDefault = async () => {
    setSavingDefault(true);
    try {
      await saveAcademyRebookRulesDefault(academyProfileId, value);
      toast({ title: t('rebookRules.savedDefault', 'Saved as default') });
    } catch (error) {
      logger.error(
        'Error saving rebook rules default',
        error instanceof Error ? error : new Error(String(error)),
        { component: 'RebookRulesField' },
      );
      toast({
        title: t('common:error', 'Error'),
        description: getFriendlyErrorMessage(error, t('rebookRules.saveDefaultError', 'Could not save as default')),
        variant: 'destructive',
      });
    } finally {
      setSavingDefault(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">
        {t('rebookRules.label', 'Rebooking rules (players must agree before paying)')}
      </Label>
      <p className="text-xs text-muted-foreground">
        {t(
          'rebookRules.help',
          'Shown on the payment page with a required "I agree" checkbox. This is separate from the message in the email above.',
        )}
      </p>
      <RichTextEditor
        value={value}
        onChange={onChange}
        placeholder={t('rebookRules.placeholder', 'e.g. Payment within 7 days. No refunds after the cycle start date.')}
      />
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={handleSaveDefault} disabled={disabled || savingDefault}>
          {savingDefault ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          {t('rebookRules.saveDefault', 'Save as default')}
        </Button>
      </div>
    </div>
  );
}
