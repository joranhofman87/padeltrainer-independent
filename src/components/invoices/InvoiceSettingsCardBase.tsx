import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabaseClient';
import {
  Building2, Save, Loader2, CheckCircle2, Mail, X, Plus, Upload,
  Trash2, Hash, Eye, Palette, RefreshCw,
} from 'lucide-react';
import { logger } from '@/lib/logger';
import { Badge } from '@/components/ui/badge';
import { formatInvoiceNumber } from '@/lib/invoiceNumber';
import { renumberDraftInvoices } from '@/lib/renumberDraftInvoices';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Translation strings the shared card needs. The trainer / academy wrappers
 * resolve these from their own i18n namespace and pass them in.
 */
export interface InvoiceSettingsLabels {
  title: string;
  description: string;
  complete: string;
  saved: string;
  saveError: string;
  saving: string;
  save: string;
  // logo
  logo: string;
  logoDescription: string;
  noLogo: string;
  uploadLogo: string;
  // banner
  bannerColor: string;
  bannerColorDescription: string;
  noColor: string;
  customColor: string;
  // fields
  businessName: string;
  businessNamePlaceholder: string;
  kvkNumber: string;
  businessAddress: string;
  btwNumber: string;
  korNote?: string;
  paymentTerms: string;
  days7: string;
  days14: string;
  days30: string;
  defaultVatRate: string;
  vatStandard: string;
  vatReduced: string;
  vatExempt: string;
  vatCustom: string;
  customVatRate: string;
  vatInclusiveNote?: string;
  domesticNote?: string;
  // numbering
  numbering: string;
  prefix: string;
  nextNumber: string;
  includeYear: string;
  previewNumber: string;
  // reply-to
  replyToEmail: string;
  replyToEmailDescription: string;
  replyToEmailPlaceholder?: string;
  // language
  invoiceLanguage: string;
  invoiceLanguageDescription: string;
  // forwarding
  forwardEmails: string;
  forwardEmailsDescription: string;
  // bulk VAT (academy only, optional)
  bulkVatLabel?: string;
  bulkVatSuccess?: string;
  bulkVatFailed?: string;
  bulkVatAutoSuccess?: string;
  // renumber dialog (drafts only — issued invoices keep their legal numbers)
  renumberTitle: string;
  renumberDescription: string;
  renumberConfirm: string;
  renumberCancel: string;
  renumberSuccess: (count: number) => string;
  renumberPartial: (updated: number, failed: number) => string;
  renumberNothing: string;
  renumberError: string;
}

export interface InvoiceSettingsCardBaseProps {
  /** Owner identifier in the underlying table. */
  ownerId: string;
  /** Backing table. */
  table: 'trainer_profiles' | 'academy_profiles';
  /** Column to match `ownerId` against. */
  ownerColumn: 'user_id' | 'id';
  /** Owner type used for renumber + bulk-VAT calls. */
  ownerType: 'trainer' | 'academy';
  /**
   * Storage path builder for the invoice logo.
   * Returns a single path used both for upload (with extension swapped) and
   * the deletion paths (one per common extension).
   */
  buildLogoPath: (ext: string) => string;
  logoCleanupExtensions?: string[];
  labels: InvoiceSettingsLabels;
  /** Show the bulk-VAT update button + auto-trigger after save. */
  enableBulkVat?: boolean;
  /** When true, also call `bulk-update-vat` automatically when VAT changes. */
  bulkVatPayloadId?: string;
  /** Optional id-prefix for form fields to avoid duplicate ids. */
  idPrefix?: string;
  onSave?: () => void;
}

const VAT_DEFAULTS = [21, 9, 0];

export function InvoiceSettingsCardBase({
  ownerId,
  table,
  ownerColumn,
  ownerType,
  buildLogoPath,
  logoCleanupExtensions = ['png', 'jpg', 'jpeg', 'webp', 'svg'],
  labels,
  enableBulkVat = false,
  bulkVatPayloadId,
  idPrefix = 'inv',
  onSave,
}: InvoiceSettingsCardBaseProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [initialVatRate, setInitialVatRate] = useState(21);
  const [renumberOwnerId, setRenumberOwnerId] = useState<string | null>(null);

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
    invoice_prefix: '',
    invoice_next_number: 1,
    invoice_include_year: true,
    invoice_language: 'nl',
  });
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [bannerColor, setBannerColor] = useState<string>('');
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [forwardEmails, setForwardEmails] = useState<string[]>([]);
  const [replyToEmail, setReplyToEmail] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [showRenumberDialog, setShowRenumberDialog] = useState(false);
  const [renumbering, setRenumbering] = useState(false);
  const [initialNumbering, setInitialNumbering] = useState({
    prefix: '',
    includeYear: true,
    startNumber: 1,
  });

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const { data } = await (supabase as any)
        .from(table)
        .select(
          'id, business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, default_vat_rate, invoice_forward_emails, invoice_reply_to_email, invoice_logo_url, invoice_prefix, invoice_next_number, invoice_banner_color, invoice_include_year, invoice_language',
        )
        .eq(ownerColumn, ownerId)
        .maybeSingle();
      if (data) {
        const d = data as any;
        const vatRate = d.default_vat_rate ?? 21;
        setInitialVatRate(vatRate);
        const isCustom = !VAT_DEFAULTS.includes(vatRate);
        setFormData({
          business_name: d.business_name || '',
          business_address: d.business_address || '',
          kvk_number: d.kvk_number || '',
          btw_number: d.btw_number || '',
          iban: d.iban || '',
          bic: d.bic || '',
          payment_terms_days: d.payment_terms_days || 14,
          default_vat_rate: isCustom ? -1 : vatRate,
          custom_vat_rate: isCustom ? String(vatRate) : '',
          invoice_prefix: d.invoice_prefix || '',
          invoice_next_number: d.invoice_next_number || 1,
          invoice_include_year: d.invoice_include_year ?? true,
          invoice_language: d.invoice_language || 'nl',
        });
        setLogoUrl(d.invoice_logo_url || null);
        setBannerColor(d.invoice_banner_color || '');
        setForwardEmails(d.invoice_forward_emails || []);
        setReplyToEmail(d.invoice_reply_to_email || '');
        setInitialNumbering({
          prefix: d.invoice_prefix || '',
          includeYear: d.invoice_include_year ?? true,
          startNumber: d.invoice_next_number || 1,
        });
        setRenumberOwnerId(d.id);
      }
      setLoading(false);
    };
    load();
  }, [table, ownerColumn, ownerId]);

  const isComplete =
    formData.business_name && formData.business_address && formData.kvk_number && formData.iban;

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      const path = buildLogoPath(ext);
      const { error } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true });
      if (error) throw error;
      const { data } = supabase.storage.from('avatars').getPublicUrl(path);
      setLogoUrl(data.publicUrl + '?t=' + Date.now());
    } catch (err) {
      toast.error(labels.saveError, { description: getFriendlyErrorMessage(err, labels.saveError) });
    }
    setUploadingLogo(false);
  };

  const handleRemoveLogo = async () => {
    try {
      const paths = logoCleanupExtensions.map((ext) => buildLogoPath(ext));
      await supabase.storage.from('avatars').remove(paths);
    } catch {
      /* non-fatal: best-effort storage cleanup; logo is cleared locally regardless */
    }
    setLogoUrl(null);
  };

  const triggerBulkVat = async (resolvedVatRate: number, isAuto: boolean) => {
    if (!bulkVatPayloadId) return;
    try {
      const { error } = await supabase.functions.invoke('bulk-update-vat', {
        body: { academyId: bulkVatPayloadId, newVatRate: resolvedVatRate, pricesIncludeVat: true },
      });
      if (error) {
        logger.error('Bulk VAT update error', error instanceof Error ? error : new Error(String(error)), {
          component: 'InvoiceSettingsCardBase',
        });
        toast.error(labels.bulkVatFailed || labels.saveError);
      } else {
        toast.success(
          isAuto
            ? labels.bulkVatAutoSuccess || labels.bulkVatSuccess || labels.saved
            : (labels.bulkVatSuccess || labels.saved),
        );
      }
    } catch (err) {
      logger.error('Bulk VAT update failed', err instanceof Error ? err : new Error(String(err)), {
        component: 'InvoiceSettingsCardBase',
      });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    const resolvedVatRate =
      formData.default_vat_rate === -1
        ? parseFloat(formData.custom_vat_rate) || 0
        : formData.default_vat_rate;

    const { error } = await (supabase as any)
      .from(table)
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
        invoice_reply_to_email: replyToEmail.trim() ? replyToEmail.trim().toLowerCase() : null,
        invoice_logo_url: logoUrl || null,
        invoice_banner_color: bannerColor || null,
        invoice_prefix: formData.invoice_prefix || null,
        invoice_next_number: formData.invoice_next_number || 1,
        invoice_include_year: formData.invoice_include_year,
        invoice_language: formData.invoice_language || 'nl',
      } as any)
      .eq(ownerColumn, ownerId);

    if (error) {
      toast.error(labels.saveError, { description: getFriendlyErrorMessage(error, labels.saveError) });
    } else {
      toast.success(labels.saved);
      onSave?.();

      if (enableBulkVat && resolvedVatRate !== initialVatRate) {
        await triggerBulkVat(resolvedVatRate, true);
        setInitialVatRate(resolvedVatRate);
      }

      const numberingChanged =
        formData.invoice_prefix !== initialNumbering.prefix ||
        formData.invoice_include_year !== initialNumbering.includeYear ||
        formData.invoice_next_number !== initialNumbering.startNumber;
      if (numberingChanged) {
        setShowRenumberDialog(true);
        setInitialNumbering({
          prefix: formData.invoice_prefix,
          includeYear: formData.invoice_include_year,
          startNumber: formData.invoice_next_number,
        });
      }
    }
    setSaving(false);
  };

  const handleBulkUpdateVat = async () => {
    const resolvedVatRate =
      formData.default_vat_rate === -1
        ? parseFloat(formData.custom_vat_rate) || 0
        : formData.default_vat_rate;
    setBulkUpdating(true);
    await triggerBulkVat(resolvedVatRate, false);
    setBulkUpdating(false);
  };

  const handleRenumberDrafts = async () => {
    if (!renumberOwnerId) {
      setShowRenumberDialog(false);
      return;
    }
    setRenumbering(true);
    try {
      const result = await renumberDraftInvoices({
        ownerType,
        ownerId: renumberOwnerId,
        prefix: formData.invoice_prefix,
        includeYear: formData.invoice_include_year,
      });
      if (result.error) {
        toast.error(labels.renumberError, { description: getFriendlyErrorMessage(result.error, labels.renumberError) });
      } else {
        // The next_invoice_sequence RPC already advanced the stored counter
        // (single source of truth) — only mirror it into the form so a later
        // save doesn't write a stale invoice_next_number back.
        const next = result.nextNumber;
        if (next != null) {
          setFormData((prev) => ({ ...prev, invoice_next_number: next }));
          setInitialNumbering((prev) => ({ ...prev, startNumber: next }));
        }
        if (result.failures.length > 0) {
          toast.error(labels.renumberPartial(result.updated, result.failures.length), {
            description: getFriendlyErrorMessage(result.failures[0].message, labels.renumberError),
          });
        } else if (result.updated > 0) {
          toast.success(labels.renumberSuccess(result.updated));
        } else {
          toast.success(labels.renumberNothing);
        }
      }
    } catch (err) {
      logger.error('Renumber failed', err instanceof Error ? err : new Error(String(err)), {
        component: 'InvoiceSettingsCardBase',
      });
      toast.error(labels.renumberError);
    }
    setRenumbering(false);
    setShowRenumberDialog(false);
  };

  if (loading) {
    return (
      <Card className={flushOnMobileCardClass()}>
        <CardContent className="py-8 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const id = (k: string) => `${idPrefix}_${k}`;

  return (
    <>
      <Card className={flushOnMobileCardClass()}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-lg">{labels.title}</CardTitle>
                <CardDescription>{labels.description}</CardDescription>
              </div>
            </div>
            {isComplete && (
              <div className="flex items-center gap-1 text-green-600 text-sm">
                <CheckCircle2 className="h-4 w-4" />
                {labels.complete}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Logo Upload */}
          <div className="space-y-3 pb-4 border-b">
            <Label>{labels.logo}</Label>
            <p className="text-xs text-muted-foreground">{labels.logoDescription}</p>
            <div className="flex items-center gap-4">
              {logoUrl ? (
                <div className="relative group">
                  <img
                    src={logoUrl}
                    alt="Invoice logo"
                    className="h-14 max-w-[200px] object-contain rounded border p-1 bg-background"
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon" aria-label="Delete"
                    className="absolute -top-2 -right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={handleRemoveLogo}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <div className="h-14 w-32 rounded border border-dashed flex items-center justify-center text-muted-foreground text-xs">
                  {labels.noLogo}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleLogoUpload}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingLogo}
              >
                {uploadingLogo ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-1" />
                )}
                {labels.uploadLogo}
              </Button>
            </div>
          </div>

          {/* Banner Color */}
          <div className="space-y-3 pb-4 border-b">
            <div className="flex items-center gap-2">
              <Palette className="h-4 w-4 text-muted-foreground" />
              <Label>{labels.bannerColor}</Label>
            </div>
            <p className="text-xs text-muted-foreground">{labels.bannerColorDescription}</p>
            <div className="flex items-center gap-2 flex-wrap">
              {[
                { color: '', label: labels.noColor },
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
                    bannerColor === preset.color
                      ? 'border-primary ring-2 ring-primary/30'
                      : 'border-border'
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
                <span className="text-xs text-muted-foreground">{labels.customColor}</span>
              </div>
            </div>
            {bannerColor && (
              <div
                className="flex items-center gap-3 p-3 rounded-md"
                style={{ backgroundColor: bannerColor }}
              >
                {logoUrl ? (
                  <img src={logoUrl} alt="Preview" className="h-8 max-w-[120px] object-contain" loading="lazy" decoding="async" />
                ) : (
                  <span className="text-white text-sm font-medium">
                    {formData.business_name || 'Your Logo Here'}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={id('business_name')}>{labels.businessName} *</Label>
              <Input
                id={id('business_name')}
                value={formData.business_name}
                onChange={(e) => setFormData({ ...formData, business_name: e.target.value })}
                placeholder={labels.businessNamePlaceholder}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('kvk_number')}>{labels.kvkNumber} *</Label>
              <Input
                id={id('kvk_number')}
                value={formData.kvk_number}
                onChange={(e) => setFormData({ ...formData, kvk_number: e.target.value })}
                placeholder="12345678"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor={id('business_address')}>{labels.businessAddress} *</Label>
            <Textarea
              id={id('business_address')}
              value={formData.business_address}
              onChange={(e) => setFormData({ ...formData, business_address: e.target.value })}
              placeholder="Straatnaam 123&#10;1234 AB Amsterdam"
              rows={2}
            />
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={id('btw_number')}>{labels.btwNumber}</Label>
              <Input
                id={id('btw_number')}
                value={formData.btw_number}
                onChange={(e) => setFormData({ ...formData, btw_number: e.target.value })}
                placeholder="NL123456789B01"
              />
              {labels.korNote && (
                <p className="text-xs text-muted-foreground">{labels.korNote}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('payment_terms')}>{labels.paymentTerms}</Label>
              <Select
                value={formData.payment_terms_days.toString()}
                onValueChange={(v) =>
                  setFormData({ ...formData, payment_terms_days: parseInt(v) })
                }
              >
                <SelectTrigger id={id('payment_terms')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">{labels.days7}</SelectItem>
                  <SelectItem value="14">{labels.days14}</SelectItem>
                  <SelectItem value="30">{labels.days30}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={id('vat_rate')}>{labels.defaultVatRate}</Label>
              <Select
                value={formData.default_vat_rate.toString()}
                onValueChange={(v) =>
                  setFormData({
                    ...formData,
                    default_vat_rate: parseInt(v),
                    custom_vat_rate:
                      parseInt(v) === -1 ? formData.custom_vat_rate : '',
                  })
                }
              >
                <SelectTrigger id={id('vat_rate')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="21">21% - {labels.vatStandard}</SelectItem>
                  <SelectItem value="9">9% - {labels.vatReduced}</SelectItem>
                  <SelectItem value="0">0% - {labels.vatExempt}</SelectItem>
                  <SelectItem value="-1">{labels.vatCustom}</SelectItem>
                </SelectContent>
              </Select>
              {labels.vatInclusiveNote && (
                <p className="text-xs text-muted-foreground">{labels.vatInclusiveNote}</p>
              )}
            </div>
            {formData.default_vat_rate === -1 && (
              <div className="space-y-2">
                <Label htmlFor={id('custom_vat')}>{labels.customVatRate}</Label>
                <Input
                  id={id('custom_vat')}
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
              <Label htmlFor={id('iban')}>IBAN *</Label>
              <Input
                id={id('iban')}
                value={formData.iban}
                onChange={(e) => setFormData({ ...formData, iban: e.target.value.toUpperCase() })}
                placeholder="NL91 ABNA 0417 1643 00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('bic')}>BIC</Label>
              <Input
                id={id('bic')}
                value={formData.bic}
                onChange={(e) => setFormData({ ...formData, bic: e.target.value.toUpperCase() })}
                placeholder="ABNANL2A"
              />
              {labels.domesticNote && (
                <p className="text-xs text-muted-foreground">{labels.domesticNote}</p>
              )}
            </div>
          </div>

          {/* Numbering */}
          <div className="space-y-3 pt-4 border-t">
            <div className="flex items-center gap-2">
              <Hash className="h-4 w-4 text-muted-foreground" />
              <Label>{labels.numbering}</Label>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor={id('prefix')}>{labels.prefix}</Label>
                <Input
                  id={id('prefix')}
                  value={formData.invoice_prefix}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      invoice_prefix: e.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, '')
                        .slice(0, 10),
                    })
                  }
                  placeholder="INV"
                  maxLength={10}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={id('next_number')}>{labels.nextNumber}</Label>
                <Input
                  id={id('next_number')}
                  type="number"
                  min="1"
                  value={formData.invoice_next_number}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      invoice_next_number: parseInt(e.target.value) || 1,
                    })
                  }
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id={id('include_year')}
                checked={formData.invoice_include_year}
                onChange={(e) =>
                  setFormData({ ...formData, invoice_include_year: e.target.checked })
                }
                className="rounded border-input"
              />
              <Label
                htmlFor={id('include_year')}
                className="text-sm font-normal cursor-pointer"
              >
                {labels.includeYear}
              </Label>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              {labels.previewNumber}:{' '}
              <span className="font-mono font-medium text-foreground">
                {formatInvoiceNumber(
                  formData.invoice_prefix,
                  new Date().getFullYear(),
                  formData.invoice_next_number || 1,
                  formData.invoice_include_year,
                )}
              </span>
            </div>
          </div>

          {/* Reply-to */}
          <div className="space-y-2 pt-4 border-t">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <Label htmlFor={id('reply_to')}>{labels.replyToEmail}</Label>
            </div>
            <p className="text-xs text-muted-foreground">{labels.replyToEmailDescription}</p>
            <Input
              id={id('reply_to')}
              type="email"
              value={replyToEmail}
              onChange={(e) => setReplyToEmail(e.target.value)}
              placeholder={labels.replyToEmailPlaceholder || 'you@example.com'}
            />
          </div>

          {/* Language */}
          <div className="space-y-2 pt-4 border-t">
            <Label htmlFor={id('language')}>{labels.invoiceLanguage}</Label>
            <p className="text-xs text-muted-foreground">{labels.invoiceLanguageDescription}</p>
            <Select
              value={formData.invoice_language}
              onValueChange={(v) => setFormData({ ...formData, invoice_language: v })}
            >
              <SelectTrigger id={id('language')} className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nl">Nederlands</SelectItem>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Español</SelectItem>
                <SelectItem value="de">Deutsch</SelectItem>
                <SelectItem value="fr">Français</SelectItem>
                <SelectItem value="it">Italiano</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Forwarding */}
          <div className="space-y-3 pt-4 border-t">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <Label>{labels.forwardEmails}</Label>
            </div>
            <p className="text-xs text-muted-foreground">{labels.forwardEmailsDescription}</p>
            <div className="flex flex-wrap gap-2">
              {forwardEmails.map((email, i) => (
                <Badge key={i} variant="secondary" className="gap-1 pr-1">
                  {email}
                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() =>
                      setForwardEmails(forwardEmails.filter((_, idx) => idx !== i))
                    }
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
                size="icon" aria-label="Add"
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

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              {saving ? labels.saving : labels.save}
            </Button>
            {enableBulkVat && labels.bulkVatLabel && (
              <Button
                variant="outline"
                onClick={handleBulkUpdateVat}
                disabled={bulkUpdating}
                className="w-full sm:w-auto"
              >
                {bulkUpdating ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {labels.bulkVatLabel}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showRenumberDialog} onOpenChange={setShowRenumberDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{labels.renumberTitle}</AlertDialogTitle>
            <AlertDialogDescription>{labels.renumberDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={renumbering}>{labels.renumberCancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRenumberDrafts} disabled={renumbering}>
              {renumbering && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {labels.renumberConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
