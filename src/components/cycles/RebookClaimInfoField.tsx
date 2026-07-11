import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { RichTextEditor } from '@/components/ui/rich-text-editor';

interface Props {
  id: string;
  /** Rich HTML; blank editor HTML (`<p></p>`) = the standard copy — normalize at write time. */
  value: string;
  onChange: (html: string) => void;
  /** Accepted for call-site symmetry; RichTextEditor has no disabled mode (same as the rules
   *  field) — callers gate the surrounding submit instead. */
  disabled?: boolean;
}

/**
 * Per-round override of the claim page's standard explanation box (the "Hoe werkt het?" /
 * "Wil je een ander moment?" copy players see when they open their rebook link). Rich text —
 * bold / lists / links via the shared RichTextEditor (same as the rules field); rendered on
 * the claim page through SafeHtml (DOMPurify). EMPTY means the standard copy, so most rounds
 * keep the maintained, translated default and only academies that want their own wording pay
 * the upkeep.
 */
export function RebookClaimInfoField({ id, value, onChange }: Props) {
  const { t } = useTranslation('cycles');
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t('rebookShared.claimInfoLabel', 'Uitleg op de bevestigingspagina (optioneel)')}</Label>
      <RichTextEditor
        value={value}
        onChange={onChange}
        placeholder={t('rebookShared.claimInfoPlaceholder', 'Leeg = de standaardtekst ("Hoe werkt het?" en "Wil je een ander moment?").')}
      />
      <p className="text-xs text-muted-foreground">
        {t('rebookShared.claimInfoHint', 'Dit vervangt het uitlegblok op de pagina waar spelers hun plek bevestigen. Laat leeg om de standaardtekst te gebruiken.')}
      </p>
    </div>
  );
}
