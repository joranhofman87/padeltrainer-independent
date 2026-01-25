import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { Building2, Save, Loader2, CheckCircle2 } from 'lucide-react';

interface InvoiceSettingsCardProps {
  userId: string;
  initialData?: {
    business_name: string | null;
    business_address: string | null;
    kvk_number: string | null;
    btw_number: string | null;
    iban: string | null;
    bic: string | null;
    payment_terms_days: number;
  };
  onSave?: () => void;
}

export function InvoiceSettingsCard({ userId, initialData, onSave }: InvoiceSettingsCardProps) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  
  const [formData, setFormData] = useState({
    business_name: '',
    business_address: '',
    kvk_number: '',
    btw_number: '',
    iban: '',
    bic: '',
    payment_terms_days: 14,
  });

  useEffect(() => {
    if (initialData) {
      setFormData({
        business_name: initialData.business_name || '',
        business_address: initialData.business_address || '',
        kvk_number: initialData.kvk_number || '',
        btw_number: initialData.btw_number || '',
        iban: initialData.iban || '',
        bic: initialData.bic || '',
        payment_terms_days: initialData.payment_terms_days || 14,
      });
    }
  }, [initialData]);

  const isComplete = formData.business_name && formData.business_address && formData.kvk_number && formData.iban;

  const handleSave = async () => {
    setSaving(true);
    
    const { error } = await supabase
      .from('trainer_profiles')
      .update({
        business_name: formData.business_name || null,
        business_address: formData.business_address || null,
        kvk_number: formData.kvk_number || null,
        btw_number: formData.btw_number || null,
        iban: formData.iban || null,
        bic: formData.bic || null,
        payment_terms_days: formData.payment_terms_days,
      })
      .eq('user_id', userId);

    if (error) {
      toast({
        title: t('common:toasts.errorTitle'),
        description: t('invoices.saveError'),
        variant: 'destructive',
      });
    } else {
      toast({
        title: t('invoices.saved'),
        description: t('invoices.savedDescription'),
      });
      onSave?.();
    }
    
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            <div>
              <CardTitle>{t('invoices.settings', 'Factuur Instellingen')}</CardTitle>
              <CardDescription>
                {t('invoices.settingsDescription', 'Bedrijfsgegevens voor je facturen')}
              </CardDescription>
            </div>
          </div>
          {isComplete && (
            <div className="flex items-center gap-1 text-green-600 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              {t('invoices.complete')}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="business_name">
              {t('invoices.businessName', 'Bedrijfsnaam')} *
            </Label>
            <Input
              id="business_name"
              value={formData.business_name}
              onChange={(e) => setFormData({ ...formData, business_name: e.target.value })}
              placeholder="Jouw Bedrijf B.V."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="kvk_number">
              {t('invoices.kvkNumber', 'KvK-nummer')} *
            </Label>
            <Input
              id="kvk_number"
              value={formData.kvk_number}
              onChange={(e) => setFormData({ ...formData, kvk_number: e.target.value })}
              placeholder="12345678"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="business_address">
            {t('invoices.businessAddress', 'Bedrijfsadres')} *
          </Label>
          <Textarea
            id="business_address"
            value={formData.business_address}
            onChange={(e) => setFormData({ ...formData, business_address: e.target.value })}
            placeholder="Straatnaam 123&#10;1234 AB Amsterdam"
            rows={2}
          />
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="btw_number">
              {t('invoices.btwNumber', 'BTW-nummer')}
            </Label>
            <Input
              id="btw_number"
              value={formData.btw_number}
              onChange={(e) => setFormData({ ...formData, btw_number: e.target.value })}
              placeholder="NL123456789B01"
            />
            <p className="text-xs text-muted-foreground">
              {t('invoices.korNote')}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment_terms_days">
              {t('invoices.paymentTerms', 'Betalingstermijn')}
            </Label>
            <Select
              value={formData.payment_terms_days.toString()}
              onValueChange={(v) => setFormData({ ...formData, payment_terms_days: parseInt(v) })}
            >
              <SelectTrigger id="payment_terms_days">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t('invoices.days7')}</SelectItem>
                <SelectItem value="14">{t('invoices.days14')}</SelectItem>
                <SelectItem value="30">{t('invoices.days30')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="iban">IBAN *</Label>
            <Input
              id="iban"
              value={formData.iban}
              onChange={(e) => setFormData({ ...formData, iban: e.target.value.toUpperCase() })}
              placeholder="NL91 ABNA 0417 1643 00"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bic">BIC</Label>
            <Input
              id="bic"
              value={formData.bic}
              onChange={(e) => setFormData({ ...formData, bic: e.target.value.toUpperCase() })}
              placeholder="ABNANL2A"
            />
            <p className="text-xs text-muted-foreground">
              {t('invoices.domesticNote')}
            </p>
          </div>
        </div>

        <Button onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
          {saving ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-2" />
          )}
          {saving ? t('invoices.saving') : t('invoices.saveSettings')}
        </Button>
      </CardContent>
    </Card>
  );
}
