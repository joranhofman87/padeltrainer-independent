import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { formatCurrency } from '@/lib/format';
import type { InvoiceFormTotals } from '@/lib/invoiceFormTotals';

export interface InvoiceTotalsLabels {
  pricesIncludeVat: string;
  subtotal: string;
  total: string;
}

interface InvoiceTotalsSummaryProps {
  totals: InvoiceFormTotals;
  pricesIncludeVat: boolean;
  onPricesIncludeVatChange: (value: boolean) => void;
  labels: InvoiceTotalsLabels;
  /** Label for a single per-rate row in the multi-rate breakdown (e.g. "VAT 21%"). */
  renderVatRateLabel: (rate: string) => string;
  /**
   * Single-rate VAT line. CREATE passes a read-only `label`. EDIT passes `editable`, which
   * renders the inline rate input (the global VAT rate the whole invoice is computed against).
   */
  singleRate:
    | { label: string }
    | { editable: { value: number; onChange: (value: number) => void; prefix: string } };
}

/**
 * Shared subtotal / VAT / total block + the "prices include VAT" toggle, used by the trainer +
 * academy create/edit invoice forms. The multi-rate breakdown shows only when there is more than
 * one effective rate (behaviour-identical to both forms: the create math already returns a null
 * breakdown for a single rate). The page keeps the surrounding Card, due-date and notes.
 */
export function InvoiceTotalsSummary({
  totals,
  pricesIncludeVat,
  onPricesIncludeVatChange,
  labels,
  renderVatRateLabel,
  singleRate,
}: InvoiceTotalsSummaryProps) {
  const { subtotal, vatAmount, total, vatBreakdown } = totals;
  const showBreakdown = vatBreakdown && Object.keys(vatBreakdown).length > 1;

  return (
    <>
      <div className="flex items-center justify-between">
        <Label className="text-sm">{labels.pricesIncludeVat}</Label>
        <Switch checked={pricesIncludeVat} onCheckedChange={onPricesIncludeVatChange} />
      </div>
      <Separator />
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{labels.subtotal}</span>
          <span>{formatCurrency(subtotal)}</span>
        </div>
        {showBreakdown ? (
          Object.entries(vatBreakdown)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([rate, data]) => (
              <div key={rate} className="flex justify-between">
                <span className="text-muted-foreground">{renderVatRateLabel(rate)}</span>
                <span>{formatCurrency(data.vat)}</span>
              </div>
            ))
        ) : 'editable' in singleRate ? (
          <div className="flex justify-between items-center gap-2">
            <span className="text-muted-foreground flex items-center gap-2">
              {singleRate.editable.prefix}
              <Input
                type="number"
                value={singleRate.editable.value}
                onChange={(e) => singleRate.editable.onChange(Number(e.target.value) || 0)}
                className="w-16 h-7 text-sm inline"
                min={0}
                max={100}
                step={1}
              />
              %
            </span>
            <span>{formatCurrency(vatAmount)}</span>
          </div>
        ) : (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{singleRate.label}</span>
            <span>{formatCurrency(vatAmount)}</span>
          </div>
        )}
        <div className="flex justify-between font-bold text-base border-t pt-2">
          <span>{labels.total}</span>
          <span>{formatCurrency(total)}</span>
        </div>
      </div>
    </>
  );
}
