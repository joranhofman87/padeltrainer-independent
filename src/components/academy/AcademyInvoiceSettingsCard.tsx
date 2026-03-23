import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { Building2, Save, Loader2, CheckCircle2, Mail, X, Plus, Upload, Trash2, Hash, Eye, Palette } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface AcademyInvoiceSettingsCardProps {
  academyId: string;
}

export function AcademyInvoiceSettingsCard({ academyId }: AcademyInvoiceSettingsCardProps) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

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
    invoice_prefix: 'INV',
    invoice_next_number: 1,
  });
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [bannerColor, setBannerColor] = useState<string>('');
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [forwardEmails, setForwardEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const { data } = await supabase
        .from('academy_profiles')
        .select('business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, default_vat_rate, invoice_forward_emails, invoice_logo_url, invoice_prefix, invoice_next_number, invoice_banner_color')
        .eq('id', academyId)
        .maybeSingle();

      if (data) {
        const vatRate = (data as any).default_vat_rate ?? 21;
        const isCustom = ![21, 9, 0].includes(vatRate);
        setFormData({
          business_name: (data as any).business_name || '',
          business_address: (data as any).business_address || '',
          kvk_number: (data as any).kvk_number || '',
          btw_number: (data as any).btw_number || '',
          iban: (data as any).iban || '',
          bic: (data as any).bic || '',
          payment_terms_days: (data as any).payment_terms_days || 14,
          default_vat_rate: isCustom ? -1 : vatRate,
          custom_vat_rate: isCustom ? vatRate.toString() : '',
          invoice_prefix: (data as any).invoice_prefix || 'INV',
          invoice_next_number: (data as any).invoice_next_number || 1,
        });
        setLogoUrl((data as any).invoice_logo_url || null);
        setBannerColor((data as any).invoice_banner_color || '');
        setForwardEmails((data as any).invoice_forward_emails || []);
      }
      setLoading(false);
    };
    load();
  }, [academyId]);

  const isComplete = formData.business_name && formData.business_address && formData.kvk_number && formData.iban;

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    try {
      const ext = file.name.split('.').pop();
      const path = `academies/${academyId}/invoice-logo.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path);
      setLogoUrl(urlData.publicUrl + '?t=' + Date.now());
    } catch (err: any) {
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
    }
    setUploadingLogo(false);
  };

  const handleRemoveLogo = async () => {
    try {
      // Try to remove common extensions
      const extensions = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
      const paths = extensions.map(ext => `academies/${academyId}/invoice-logo.${ext}`);
      await supabase.storage.from('avatars').remove(paths);
    } catch {}
    setLogoUrl(null);
  };

  const handleSave = async () => {
    setSaving(true);
    const resolvedVatRate = formData.default_vat_rate === -1
      ? parseFloat(formData.custom_vat_rate) || 0
      : formData.default_vat_rate;

    const { error } = await supabase
      .from('academy_profiles')
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
        invoice_logo_url: logoUrl || null,
        invoice_prefix: formData.invoice_prefix || 'INV',
        invoice_next_number: formData.invoice_next_number || 1,
        invoice_banner_color: bannerColor || null,
      } as any)
      .eq('id', academyId);

    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('invoiceSettings.saved') });
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-lg">{t('invoiceSettings.title')}</CardTitle>
              <CardDescription>{t('invoiceSettings.description')}</CardDescription>
            </div>
          </div>
          {isComplete && (
            <div className="flex items-center gap-1 text-green-600 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              {t('invoiceSettings.complete')}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Logo Upload */}
        <div className="space-y-3 pb-4 border-b">
          <Label>{t('invoiceSettings.logo')}</Label>
          <p className="text-xs text-muted-foreground">{t('invoiceSettings.logoDescription')}</p>
          <div className="flex items-center gap-4">
            {logoUrl ? (
              <div className="relative group">
                <img src={logoUrl} alt="Invoice logo" className="h-14 max-w-[200px] object-contain rounded border p-1 bg-background" />
                <Button type="button" variant="destructive" size="icon" className="absolute -top-2 -right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity" onClick={handleRemoveLogo}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="h-14 w-32 rounded border border-dashed flex items-center justify-center text-muted-foreground text-xs">
                {t('invoiceSettings.noLogo')}
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadingLogo}>
              {uploadingLogo ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
              {t('invoiceSettings.uploadLogo')}
            </Button>
          </div>
        </div>

        {/* Banner Color */}
        <div className="space-y-3 pb-4 border-b">
          <div className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-muted-foreground" />
            <Label>{t('invoiceSettings.bannerColor')}</Label>
          </div>
          <p className="text-xs text-muted-foreground">{t('invoiceSettings.bannerColorDescription')}</p>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { color: '', label: t('invoiceSettings.noColor') },
              { color: '#1a2332', label: 'Navy' },
              { color: '#000000', label: 'Black' },
              { color: '#1e3a5f', label: 'Blue' },
              { color: '#2d4a3e', label: 'Green' },
            ].map((preset) => (
              <button
                key={preset.color}
                type="button"
                onClick={() => setBannerColor(preset.color)}
                className={`h-8 rounded border-2 px-3 text-xs font-medium transition-all ${
                  bannerColor === preset.color ? 'border-primary ring-2 ring-primary/30' : 'border-border'
                } ${preset.color ? 'text-white' : 'bg-background text-foreground'}`}
                style={preset.color ? { backgroundColor: preset.color } : undefined}
              >
                {preset.label}
              </button>
            ))}
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={bannerColor || '#1a2332'}
                onChange={(e) => setBannerColor(e.target.value)}
                className="h-8 w-8 rounded border cursor-pointer"
              />
              <span className="text-xs text-muted-foreground">{t('invoiceSettings.customColor')}</span>
            </div>
          </div>
          {bannerColor && (
            <div className="flex items-center gap-3 p-3 rounded-md" style={{ backgroundColor: bannerColor }}>
              {logoUrl ? (
                <img src={logoUrl} alt="Preview" className="h-8 max-w-[120px] object-contain" />
              ) : (
                <span className="text-white text-sm font-medium">{formData.business_name || 'Your Logo Here'}</span>
              )}
            </div>
          )}
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ac_business_name">{t('invoiceSettings.businessName')} *</Label>
            <Input id="ac_business_name" value={formData.business_name} onChange={(e) => setFormData({ ...formData, business_name: e.target.value })} placeholder="Academy B.V." />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ac_kvk_number">{t('invoiceSettings.kvkNumber')} *</Label>
            <Input id="ac_kvk_number" value={formData.kvk_number} onChange={(e) => setFormData({ ...formData, kvk_number: e.target.value })} placeholder="12345678" />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="ac_business_address">{t('invoiceSettings.businessAddress')} *</Label>
          <Textarea id="ac_business_address" value={formData.business_address} onChange={(e) => setFormData({ ...formData, business_address: e.target.value })} placeholder="Straatnaam 123&#10;1234 AB Amsterdam" rows={2} />
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ac_btw_number">{t('invoiceSettings.btwNumber')}</Label>
            <Input id="ac_btw_number" value={formData.btw_number} onChange={(e) => setFormData({ ...formData, btw_number: e.target.value })} placeholder="NL123456789B01" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ac_payment_terms">{t('invoiceSettings.paymentTerms')}</Label>
            <Select value={formData.payment_terms_days.toString()} onValueChange={(v) => setFormData({ ...formData, payment_terms_days: parseInt(v) })}>
              <SelectTrigger id="ac_payment_terms"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t('invoiceSettings.days7')}</SelectItem>
                <SelectItem value="14">{t('invoiceSettings.days14')}</SelectItem>
                <SelectItem value="30">{t('invoiceSettings.days30')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ac_vat_rate">{t('invoiceSettings.defaultVatRate')}</Label>
            <Select value={formData.default_vat_rate.toString()} onValueChange={(v) => setFormData({ ...formData, default_vat_rate: parseInt(v), custom_vat_rate: parseInt(v) === -1 ? formData.custom_vat_rate : '' })}>
              <SelectTrigger id="ac_vat_rate"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="21">21% - {t('invoiceSettings.vatStandard')}</SelectItem>
                <SelectItem value="9">9% - {t('invoiceSettings.vatReduced')}</SelectItem>
                <SelectItem value="0">0% - {t('invoiceSettings.vatExempt')}</SelectItem>
                <SelectItem value="-1">{t('invoiceSettings.vatCustom')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {formData.default_vat_rate === -1 && (
            <div className="space-y-2">
              <Label htmlFor="ac_custom_vat">{t('invoiceSettings.customVatRate')}</Label>
              <Input id="ac_custom_vat" type="number" min="0" max="100" step="0.1" value={formData.custom_vat_rate} onChange={(e) => setFormData({ ...formData, custom_vat_rate: e.target.value })} placeholder="5" />
            </div>
          )}
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ac_iban">IBAN *</Label>
            <Input id="ac_iban" value={formData.iban} onChange={(e) => setFormData({ ...formData, iban: e.target.value.toUpperCase() })} placeholder="NL91 ABNA 0417 1643 00" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ac_bic">BIC</Label>
            <Input id="ac_bic" value={formData.bic} onChange={(e) => setFormData({ ...formData, bic: e.target.value.toUpperCase() })} placeholder="ABNANL2A" />
          </div>
        </div>

        {/* Invoice Numbering */}
        <div className="space-y-3 pt-4 border-t">
          <div className="flex items-center gap-2">
            <Hash className="h-4 w-4 text-muted-foreground" />
            <Label>{t('invoiceSettings.numbering')}</Label>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ac_prefix">{t('invoiceSettings.prefix')}</Label>
              <Input id="ac_prefix" value={formData.invoice_prefix} onChange={(e) => setFormData({ ...formData, invoice_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) })} placeholder="INV" maxLength={10} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ac_next_number">{t('invoiceSettings.nextNumber')}</Label>
              <Input id="ac_next_number" type="number" min="1" value={formData.invoice_next_number} onChange={(e) => setFormData({ ...formData, invoice_next_number: parseInt(e.target.value) || 1 })} />
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Eye className="h-3.5 w-3.5" />
            {t('invoiceSettings.previewNumber')}: <span className="font-mono font-medium text-foreground">{formData.invoice_prefix}-{new Date().getFullYear()}-{(formData.invoice_next_number || 1).toString().padStart(4, '0')}</span>
          </div>
        </div>

        {/* Forward Emails */}
        <div className="space-y-3 pt-4 border-t">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <Label>{t('invoiceSettings.forwardEmails')}</Label>
          </div>
          <p className="text-xs text-muted-foreground">{t('invoiceSettings.forwardEmailsDescription')}</p>
          <div className="flex flex-wrap gap-2">
            {forwardEmails.map((email, i) => (
              <Badge key={i} variant="secondary" className="gap-1 pr-1">
                {email}
                <button type="button" onClick={() => setForwardEmails(forwardEmails.filter((_, idx) => idx !== i))} className="ml-1 rounded-full hover:bg-muted p-0.5">
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
            <Button type="button" variant="outline" size="icon" onClick={() => {
              const email = newEmail.trim().toLowerCase();
              if (email && email.includes('@') && !forwardEmails.includes(email)) {
                setForwardEmails([...forwardEmails, email]);
                setNewEmail('');
              }
            }}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Button onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          {t('common.save')}
        </Button>
      </CardContent>
    </Card>
  );
}
