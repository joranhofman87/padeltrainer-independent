import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Per-round override of the claim page's standard explanation box (the "Hoe werkt het?" /
 * "Wil je een ander moment?" copy players see when they open their rebook link). Plain text,
 * line breaks preserved; EMPTY means the standard copy — so most rounds keep the maintained,
 * translated default and only academies that want their own wording pay the upkeep.
 */
export function RebookClaimInfoField({ id, value, onChange, disabled }: Props) {
  const { t } = useTranslation('cycles');
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t('rebookShared.claimInfoLabel', 'Uitleg op de bevestigingspagina (optioneel)')}</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        maxLength={4000}
        rows={5}
        placeholder={t('rebookShared.claimInfoPlaceholder', 'Leeg = de standaardtekst ("Hoe werkt het?" en "Wil je een ander moment?").')}
      />
      <p className="text-xs text-muted-foreground">
        {t('rebookShared.claimInfoHint', 'Dit vervangt het uitlegblok op de pagina waar spelers hun plek bevestigen. Laat leeg om de standaardtekst te gebruiken.')}
      </p>
    </div>
  );
}
