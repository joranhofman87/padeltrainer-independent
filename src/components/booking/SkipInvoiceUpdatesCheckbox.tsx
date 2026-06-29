import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';

interface SkipInvoiceUpdatesCheckboxProps {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  id?: string;
}

/**
 * Shared "Don't update invoices" control for roster edits (add / remove player).
 * Default OFF; when ticked, the player is still added/removed but no invoice is
 * created, recalculated, or cancelled — the owner reconciles billing manually.
 * The state is owned by the parent surface (sticky across a cycle-page session),
 * so this is a controlled component.
 */
export function SkipInvoiceUpdatesCheckbox({
  checked,
  onCheckedChange,
  disabled,
  id = 'skip-invoice-updates',
}: SkipInvoiceUpdatesCheckboxProps) {
  const { t } = useTranslation('trainer');
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <label htmlFor={id} className="cursor-pointer text-sm leading-snug">
        <span className="font-medium">{t('bookings.skipInvoiceUpdates', "Don't update invoices")}</span>
        <span className="mt-0.5 block text-muted-foreground">
          {t(
            'bookings.skipInvoiceUpdatesHelp',
            'The player is added or removed, but invoices are left unchanged — adjust billing yourself.',
          )}
        </span>
      </label>
    </div>
  );
}
