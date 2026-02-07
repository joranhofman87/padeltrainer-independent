import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { Building2, Save, Loader2, CheckCircle2, Mail, X, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

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
    default_vat_rate: number | null;
    invoice_forward_emails: string[] | null;
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
    default_vat_rate: 21,
    custom_vat_rate: '',
  });
  const [forwardEmails, setForwardEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');

  useEffect(() => {
    if (initialData) {
      const vatRate = initialData.default_vat_rate ?? 21;
      const isCustom = ![21, 9, 0].includes(vatRate);
      setFormData({
        business_name: initialData.business_name || '',
        business_address: initialData.business_address || '',
        kvk_number: initialData.kvk_number || '',
        btw_number: initialData.btw_number || '',
        iban: initialData.iban || '',
        bic: initialData.bic || '',
        payment_terms_days: initialData.payment_terms_days || 14,
        default_vat_rate: isCustom ? -1 : vatRate,
        custom_vat_rate: isCustom ? vatRate.toString() : '',
      });
      setForwardEmails(initialData.invoice_forward_emails || []);
    }
  }, [initialData]);

  const isComplete = formData.business_name && formData.business_address && formData.kvk_number && formData.iban;

  const handleSave = async () => {
    setSaving(true);
    
    const resolvedVatRate = formData.default_vat_rate === -1
      ? parseFloat(formData.custom_vat_rate) || 0
      : formData.default_vat_rate;

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
        default_vat_rate: resolvedVatRate,
        invoice_forward_emails: forwardEmails.length > 0 ? forwardEmails : null,
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
            <Label htmlFor="default_vat_rate">
              {t('invoices.defaultVatRate', 'Standaard BTW-tarief')}
            </Label>
            <Select
              value={formData.default_vat_rate.toString()}
              onValueChange={(v) => setFormData({ ...formData, default_vat_rate: parseInt(v), custom_vat_rate: parseInt(v) === -1 ? formData.custom_vat_rate : '' })}
            >
              <SelectTrigger id="default_vat_rate">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="21">21% - {t('invoices.vatStandard', 'Standaard tarief')}</SelectItem>
                <SelectItem value="9">9% - {t('invoices.vatReduced', 'Laag tarief')}</SelectItem>
                <SelectItem value="0">0% - {t('invoices.vatExempt', 'Vrijgesteld / KOR')}</SelectItem>
                <SelectItem value="-1">{t('invoices.vatCustom', 'Anders...')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('invoices.vatInclusiveNote', 'Lesprijzen zijn inclusief BTW. Dit tarief wordt gebruikt voor automatische facturen.')}
            </p>
          </div>
          {formData.default_vat_rate === -1 && (
            <div className="space-y-2">
              <Label htmlFor="custom_vat_rate">
                {t('invoices.customVatRate', 'BTW-percentage')}
              </Label>
              <Input
                id="custom_vat_rate"
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={formData.custom_vat_rate}
                onChange={(e) => setFormData({ ...formData, custom_vat_rate: e.target.value })}
                placeholder="5"
              />
            </div>
          )}
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

        {/* Invoice Forwarding Emails */}
        <div className="space-y-3 pt-4 border-t">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <Label>{t('invoices.forwardEmails', 'Facturen doorsturen')}</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('invoices.forwardEmailsDescription', 'Betaalde facturen worden automatisch doorgestuurd naar deze e-mailadressen (bijv. boekhoudsoftware).')}
          </p>
          <div className="flex flex-wrap gap-2">
            {forwardEmails.map((email, i) => (
              <Badge key={i} variant="secondary" className="gap-1 pr-1">
                {email}
                <button
                  type="button"
                  onClick={() => setForwardEmails(forwardEmails.filter((_, idx) => idx !== i))}
                  className="ml-1 rounded-full hover:bg-muted p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="boekhouder@example.com"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const email = newEmail.trim().toLowerCase();
                  if (email && email.includes('@') && !forwardEmails.includes(email)) {
                    setForwardEmails([...forwardEmails, email]);
                    setNewEmail('');
                  }
                }
              }}
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                const email = newEmail.trim().toLowerCase();
                if (email && email.includes('@') && !forwardEmails.includes(email)) {
                  setForwardEmails([...forwardEmails, email]);
                  setNewEmail('');
                }
              }}
            >
              <Plus className="h-4 w-4" />
            </Button>
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
