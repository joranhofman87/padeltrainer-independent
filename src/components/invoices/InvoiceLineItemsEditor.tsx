import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@/lib/format';
import type { InvoiceFormLineItem } from '@/lib/invoiceFormTotals';

export interface InvoiceLineItemsLabels {
  title: string;
  description: string;
  descriptionPlaceholder: string;
  quantity: string;
  price: string;
  vatPercent: string;
  total: string;
  addRow: string;
  removeRow: string;
  /** Mobile per-row total line — create + edit render it with different phrasing. */
  formatMobileTotal: (amount: string) => string;
}

interface PresetCost {
  description: string;
  price: number;
  vat_rate: number;
}

interface InvoiceLineItemsEditorProps {
  lineItems: InvoiceFormLineItem[];
  onChange: (next: InvoiceFormLineItem[]) => void;
  /** VAT rate for a freshly-added blank row (create: 21; edit: the invoice's global rate). */
  newRowVatRate: number;
  labels: InvoiceLineItemsLabels;
  /** Role-configured preset picker; receives an `addPreset` callback that appends a row. */
  presetPicker?: (addPreset: (cost: PresetCost) => void) => ReactNode;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Shared line-items editor for the trainer + academy create/edit invoice forms (previously
 * duplicated pixel-for-pixel in all four pages). Owns the identical update/remove/add array logic;
 * role/mode-specific labels and the preset picker are injected by the caller.
 */
export function InvoiceLineItemsEditor({
  lineItems,
  onChange,
  newRowVatRate,
  labels,
  presetPicker,
}: InvoiceLineItemsEditorProps) {
  const updateLineItem = (index: number, field: keyof InvoiceFormLineItem, value: string | number) => {
    const updated = [...lineItems];
    const item = { ...updated[index] };
    if (field === 'description') item.description = value as string;
    else if (field === 'quantity') item.quantity = value === '' || value === 0 ? 0 : parseInt(String(value)) || 0;
    else if (field === 'unit_price') item.unit_price = Number(value) || 0;
    else if (field === 'vat_rate') item.vat_rate = Number(value) || 0;
    item.amount = r2(item.quantity * item.unit_price);
    updated[index] = item;
    onChange(updated);
  };

  const removeLineItem = (index: number) => onChange(lineItems.filter((_, i) => i !== index));

  const addBlankRow = () =>
    onChange([...lineItems, { description: '', quantity: 1, unit_price: 0, amount: 0, vat_rate: newRowVatRate }]);

  const addPreset = (cost: PresetCost) =>
    onChange([
      ...lineItems,
      { description: cost.description, quantity: 1, unit_price: cost.price, amount: cost.price, vat_rate: cost.vat_rate },
    ]);

  return (
    <Card className={flushOnMobileCardClass()}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{labels.title}</CardTitle>
          <div className="flex items-center gap-1">
            {presetPicker?.(addPreset)}
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={addBlankRow}>
              <Plus className="h-3 w-3 mr-1" />
              {labels.addRow}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {/* Desktop */}
          <div className="hidden md:block space-y-2">
            <div className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center text-xs font-medium text-muted-foreground px-1">
              <span>{labels.description}</span>
              <span>{labels.quantity}</span>
              <span>{labels.price}</span>
              <span>{labels.vatPercent}</span>
              <span>{labels.total}</span>
              <span></span>
            </div>
            {lineItems.map((li, i) => (
              <div key={i} className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center">
                <Input value={li.description} onChange={(e) => updateLineItem(i, 'description', e.target.value)} placeholder={labels.descriptionPlaceholder} className="text-sm" />
                <Input type="number" value={li.quantity === 0 ? '' : li.quantity} onChange={(e) => updateLineItem(i, 'quantity', e.target.value)} onBlur={() => { if (!li.quantity || li.quantity < 1) updateLineItem(i, 'quantity', 1); }} className="text-sm" min={1} />
                <Input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)} className="text-sm" step="0.01" min={0} />
                <div className="relative">
                  <Input type="number" value={li.vat_rate || ''} onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)} className="text-sm pr-5" min={0} max={100} step={1} />
                  <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                </div>
                <div className="text-right text-sm font-medium py-2">{formatCurrency(li.quantity * li.unit_price)}</div>
                <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={labels.removeRow} onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1}>
                  <Trash2 className="h-3 w-3 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
          {/* Mobile */}
          <div className="md:hidden space-y-3">
            {lineItems.map((li, i) => (
              <div key={i} className="border rounded-lg p-3 space-y-2 bg-muted/30">
                <div className="flex items-center gap-2">
                  <Input value={li.description} onChange={(e) => updateLineItem(i, 'description', e.target.value)} placeholder={labels.descriptionPlaceholder} className="text-sm flex-1" />
                  <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" aria-label={labels.removeRow} onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1}>
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div><Label className="text-xs text-muted-foreground">{labels.quantity}</Label><Input type="number" value={li.quantity === 0 ? '' : li.quantity} onChange={(e) => updateLineItem(i, 'quantity', e.target.value)} onBlur={() => { if (!li.quantity || li.quantity < 1) updateLineItem(i, 'quantity', 1); }} className="text-sm" min={1} /></div>
                  <div><Label className="text-xs text-muted-foreground">{labels.price}</Label><Input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)} className="text-sm" step="0.01" min={0} /></div>
                  <div><Label className="text-xs text-muted-foreground">{labels.vatPercent}</Label><div className="relative"><Input type="number" value={li.vat_rate || ''} onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)} className="text-sm pr-5" min={0} max={100} step={1} /><span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span></div></div>
                </div>
                <div className="text-right text-sm font-medium">{labels.formatMobileTotal(formatCurrency(li.quantity * li.unit_price))}</div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
