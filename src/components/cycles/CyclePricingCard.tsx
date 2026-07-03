import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2, Plus, Euro } from 'lucide-react';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
import type { ExtraCost } from '@/lib/cycles';

interface CyclePricingCardProps {
  pricePerSession: number | null;
  extraCosts: ExtraCost[];
  splitPayment: boolean;
  pricesIncludeVat: boolean;
  onPricePerSessionChange: (v: number | null) => void;
  onExtraCostsChange: (v: ExtraCost[]) => void;
  onSplitPaymentChange: (v: boolean) => void;
  onPricesIncludeVatChange: (v: boolean) => void;
  academyProfileId?: string | null;
}

export default function CyclePricingCard({
  pricePerSession,
  extraCosts,
  splitPayment,
  pricesIncludeVat,
  onPricePerSessionChange,
  onExtraCostsChange,
  onSplitPaymentChange,
  onPricesIncludeVatChange,
  academyProfileId,
}: CyclePricingCardProps) {
  const { t } = useTranslation('cycles');

  const addExtraCost = () => {
    onExtraCostsChange([...extraCosts, { description: '', price: 0, type: 'one_time', vat_rate: 21 }]);
  };

  const updateExtraCost = (index: number, updates: Partial<ExtraCost>) => {
    const updated = [...extraCosts];
    updated[index] = { ...updated[index], ...updates };
    onExtraCostsChange(updated);
  };

  const removeExtraCost = (index: number) => {
    onExtraCostsChange(extraCosts.filter((_, i) => i !== index));
  };

  const handlePresetSelect = (cost: ExtraCost) => {
    onExtraCostsChange([...extraCosts, cost]);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Euro className="h-4 w-4" />
          {t('pricing.title', 'Pricing & Payment')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Price per session */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm">{t('pricing.pricePerSession', 'Price per session')}</Label>
            <MoneyInput
              min={0}
              step={0.01}
              value={pricePerSession ?? ''}
              onChange={(e) => onPricePerSessionChange(e.target.value ? Number(e.target.value) : null)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">{t('pricing.vatMode', 'VAT mode')}</Label>
            <div className="flex items-center gap-2 h-10">
              <Switch
                checked={pricesIncludeVat}
                onCheckedChange={onPricesIncludeVatChange}
              />
              <span className="text-sm text-muted-foreground">
                {pricesIncludeVat
                  ? t('pricing.includesVat', 'Prices include VAT')
                  : t('pricing.excludesVat', 'Prices exclude VAT')}
              </span>
            </div>
          </div>
        </div>

        {/* Split payment */}
        <div className="flex items-center justify-between py-1">
          <div>
            <Label className="text-sm">{t('pricing.splitPayment', 'Split payment')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('pricing.splitPaymentDesc', 'Allow players to pay per session instead of the full amount')}
            </p>
          </div>
          <Switch
            checked={splitPayment}
            onCheckedChange={onSplitPaymentChange}
          />
        </div>

        {/* Extra costs */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('pricing.extraCosts', 'Extra costs')}</Label>
            <div className="flex gap-1">
              <ExtraCostPresetPicker
                academyProfileId={academyProfileId}
                onSelect={handlePresetSelect}
              />
              <Button type="button" variant="outline" size="sm" onClick={addExtraCost}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t('pricing.addCost', 'Add')}
              </Button>
            </div>
          </div>
          {extraCosts.map((cost, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={cost.description}
                onChange={(e) => updateExtraCost(i, { description: e.target.value })}
                placeholder={t('pricing.description', 'Description')}
                className="flex-1 h-8 text-sm"
              />
              <MoneyInput
                size="sm"
                wrapperClassName="w-24"
                min={0}
                step={0.01}
                value={cost.price}
                onChange={(e) => updateExtraCost(i, { price: Number(e.target.value) })}
              />
              <Select
                value={cost.type || 'one_time'}
                onValueChange={(v) => updateExtraCost(i, { type: v as 'per_session' | 'one_time' })}
              >
                <SelectTrigger className="w-28 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="one_time">{t('pricing.oneTime', 'One-time')}</SelectItem>
                  <SelectItem value="per_session">{t('pricing.perSession', 'Per session')}</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" variant="ghost" size="icon" aria-label="Delete" className="h-8 w-8" onClick={() => removeExtraCost(i)}>
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
