import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { InvoiceStatusBadge } from '@/components/invoices/InvoiceStatusBadge';
import { deriveInvoiceStatus } from '@/lib/invoiceStatus';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { formatCurrency } from '@/lib/format';
import {
  FileText,
  Download,
  Loader2,
  Pencil,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { clearSignupClaimSource, isPaidInvoiceClaimFlow } from '@/lib/signupClaimFlow';
import { surfaceCardClass } from '@/components/ui/app-page';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { cn } from '@/lib/utils';
import { trackInvoiceClaimOutcome } from '@/lib/invoiceClaimTracking';
import { nl, enUS, es, de, fr, it } from 'date-fns/locale';

interface PlayerInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  player_name: string;
  player_business_name: string | null;
  player_address: string | null;
  player_btw_number: string | null;
  subtotal: number;
  vat_rate: number;
  vat_amount: number;
  total: number;
  status: string;
  pdf_url: string | null;
  sent_at: string | null;
  paid_at: string | null;
  notes: string | null;
  // Phase 3.5a: false for guest-keyed/both-keyed invoices of a merged person —
  // those rows belong to the guest side (FAM-02) and their billing identity is
  // managed by the trainer/academy. Undefined on the legacy fallback path (treated
  // as editable, matching pre-3.5a behavior where only pure-profile rows appeared).
  can_edit_billing?: boolean;
}

interface PlayerInvoicesTabProps {
  profileId: string;
}

const DATE_LOCALES: Record<string, typeof enUS> = { en: enUS, nl, es, de, fr, it };

export function PlayerInvoicesTab({ profileId }: PlayerInvoicesTabProps) {
  const { t, i18n } = useTranslation('player');
  const { toast } = useToast();
  const dateLocale = DATE_LOCALES[i18n.language] || enUS;
  const [invoices, setInvoices] = useState<PlayerInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadLoading, setDownloadLoading] = useState<string | null>(null);
  const [editingInvoice, setEditingInvoice] = useState<PlayerInvoice | null>(null);
  const [billingBusinessName, setBillingBusinessName] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [billingBtw, setBillingBtw] = useState('');
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchInvoices();
  }, [profileId]);

  const fetchInvoices = async () => {
    setLoading(true);
    // Phase 3.5a: the person-keyed reader is the primary path — it also returns a
    // merged person's guest-keyed invoices (invisible to the direct player_id
    // select). Fall back to the legacy direct query if the RPC isn't deployed yet
    // (congruent degradation: exactly the pre-3.5a list).
    let data: PlayerInvoice[] | null = null;
    let error: { message: string } | null = null;
    const rpcRes = await supabase.rpc('get_my_invoices');
    if (rpcRes.error) {
      logger.warn('get_my_invoices RPC unavailable, using legacy direct query', {
        component: 'PlayerInvoicesTab',
        message: rpcRes.error.message,
      });
      const legacy = await supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, due_date, player_name, player_business_name, player_address, player_btw_number, subtotal, vat_rate, vat_amount, total, status, pdf_url, sent_at, paid_at, notes')
        .eq('player_id', profileId)
        .neq('status', 'draft')
        .order('invoice_date', { ascending: false });
      data = legacy.data as PlayerInvoice[] | null; // legacy rows: no can_edit_billing → edit stays enabled (old behavior)
      error = legacy.error;
    } else {
      data = rpcRes.data as PlayerInvoice[] | null;
    }

    if (error) {
      logger.error('Error fetching player invoices', error as unknown as Error, { component: 'PlayerInvoicesTab' });
      toast({ title: t('playerInvoices.loadError'), description: t('playerInvoices.loadError'), variant: 'destructive' });
    } else {
      const now = new Date();
      const processed = (data || []).map(inv => ({
        ...inv,
        status: deriveInvoiceStatus(inv, now),
      })) as PlayerInvoice[];
      setInvoices(processed);
      try {
        trackInvoiceClaimOutcome(processed.length);
      } catch {
        /* analytics must not block invoice list */
      }
      if (processed.length > 0) {
        clearSignupClaimSource();
      }
    }
    setLoading(false);
  };

  const handleDownload = async (invoice: PlayerInvoice) => {
    setDownloadLoading(invoice.id);
    try {
      const { downloadInvoicePdf } = await import('@/lib/downloadInvoicePdf');
      const ok = await downloadInvoicePdf(invoice.id, invoice.invoice_number);
      if (!ok) {
        toast({ title: t('playerInvoices.actions.pdfError'), description: t('playerInvoices.actions.pdfError'), variant: 'destructive' });
      }
    } catch {
      toast({ title: t('playerInvoices.actions.pdfError'), description: t('playerInvoices.actions.pdfError'), variant: 'destructive' });
    }
    setDownloadLoading(null);
  };

  const openEditBilling = (invoice: PlayerInvoice) => {
    setEditingInvoice(invoice);
    setBillingBusinessName(invoice.player_business_name || '');
    setBillingAddress(invoice.player_address || '');
    setBillingBtw(invoice.player_btw_number || '');
    setSaveAsDefault(false);
  };

  const handleSaveBilling = async () => {
    if (!editingInvoice) return;
    setSaving(true);

    const { error } = await supabase
      .from('invoices')
      .update({
        player_business_name: billingBusinessName || null,
        player_address: billingAddress || null,
        player_btw_number: billingBtw || null,
        pdf_url: null,
      } as any)
      .eq('id', editingInvoice.id)
      .eq('player_id', profileId);

    if (error) {
      toast({ title: t('playerInvoices.billingDialog.saveError'), description: t('playerInvoices.billingDialog.saveError'), variant: 'destructive' });
      setSaving(false);
      return;
    }

    if (saveAsDefault) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase
          .from('profiles')
          .update({
            billing_business_name: billingBusinessName || null,
            billing_address: billingAddress || null,
            billing_btw_number: billingBtw || null,
          } as any)
          .eq('user_id', user.id);
      }
    }

    toast({ title: t('common:saved', 'Saved'), description: t('playerInvoices.billingDialog.savedToast') });
    setEditingInvoice(null);
    fetchInvoices();
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (invoices.length === 0) {
    const claimEmpty = isPaidInvoiceClaimFlow();
    // Claim flow keeps its bulleted-steps variant; the simple case reuses the
    // shared EmptyState for consistency with the rest of the app.
    if (claimEmpty) {
      return (
        <Card className={cn(surfaceCardClass(), 'p-12 text-center')} data-testid="player-invoices-empty">
          <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-xl font-semibold mb-2">{t('playerInvoices.empty.title')}</h3>
          <div
            className="mx-auto max-w-md space-y-3 text-left text-muted-foreground"
            data-testid="player-invoices-empty-claim"
          >
            <p className="text-center font-medium text-foreground">{t('playerInvoices.empty.claimLead')}</p>
            <ul className="list-disc space-y-2 pl-5 text-sm">
              <li>{t('playerInvoices.empty.claimStep1')}</li>
              <li>{t('playerInvoices.empty.claimStep2')}</li>
            </ul>
          </div>
        </Card>
      );
    }
    return (
      <Card className={cn(surfaceCardClass(), 'p-2')} data-testid="player-invoices-empty">
        <EmptyState
          icon={FileText}
          title={t('playerInvoices.empty.title')}
          description={t('playerInvoices.empty.description')}
        />
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {invoices.map((invoice) => (
          <Card key={invoice.id} className={flushOnMobileCardClass()}>
            <CardContent className="p-5 sm:p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold font-mono">{invoice.invoice_number}</p>
                    <InvoiceStatusBadge status={deriveInvoiceStatus(invoice)} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-muted-foreground">
                    <span>
                      {t('playerInvoices.labels.date', { date: format(parseISO(invoice.invoice_date), 'd MMM yyyy', { locale: dateLocale }) })}
                    </span>
                    {invoice.status !== 'paid' && (
                      <span className={invoice.status === 'overdue' ? 'text-destructive' : ''}>
                        {t('playerInvoices.labels.due', { date: format(parseISO(invoice.due_date), 'd MMM yyyy', { locale: dateLocale }) })}
                      </span>
                    )}
                    {invoice.paid_at && (
                      <span className="text-green-600">
                        {t('playerInvoices.labels.paid', { date: format(parseISO(invoice.paid_at), 'd MMM yyyy', { locale: dateLocale }) })}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-xl font-bold">{formatCurrency(invoice.total)}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('playerInvoices.labels.vatIncluded', { rate: invoice.vat_rate })}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    {/* Phase 3.5a: billing edit is pure-profile only — a guest-keyed
                        invoice of a merged person is viewable but its billing identity
                        is managed by the trainer/academy (matches the UPDATE policy). */}
                    {invoice.can_edit_billing !== false && (
                      <Button
                        variant="ghost"
                        size="icon" aria-label={t('playerInvoices.actions.editBilling', 'Edit billing details')}
                        onClick={() => openEditBilling(invoice)}
                        title={t('playerInvoices.actions.editBilling')}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon" aria-label={t('playerInvoices.actions.downloadPdf', 'Download PDF')}
                      onClick={() => handleDownload(invoice)}
                      disabled={downloadLoading === invoice.id}
                      title={t('playerInvoices.actions.downloadPdf')}
                    >
                      {downloadLoading === invoice.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Edit Billing Details Dialog */}
      <Dialog open={!!editingInvoice} onOpenChange={(open) => !open && setEditingInvoice(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('playerInvoices.billingDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="billing-business-name">{t('playerInvoices.billingDialog.businessName')}</Label>
              <Input
                id="billing-business-name"
                value={billingBusinessName}
                onChange={(e) => setBillingBusinessName(e.target.value)}
                placeholder={t('playerInvoices.billingDialog.businessNamePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billing-address">{t('playerInvoices.billingDialog.address')}</Label>
              <Textarea
                id="billing-address"
                value={billingAddress}
                onChange={(e) => setBillingAddress(e.target.value)}
                placeholder={t('playerInvoices.billingDialog.addressPlaceholder')}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billing-btw">{t('playerInvoices.billingDialog.btw')}</Label>
              <Input
                id="billing-btw"
                value={billingBtw}
                onChange={(e) => setBillingBtw(e.target.value)}
                placeholder={t('playerInvoices.billingDialog.btwPlaceholder')}
              />
            </div>
            <div className="flex items-center space-x-2 pt-2">
              <Checkbox
                id="save-as-default"
                checked={saveAsDefault}
                onCheckedChange={(checked) => setSaveAsDefault(checked === true)}
              />
              <Label htmlFor="save-as-default" className="text-sm font-normal cursor-pointer">
                {t('playerInvoices.billingDialog.saveAsDefault')}
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingInvoice(null)}>
              {t('playerInvoices.billingDialog.cancel')}
            </Button>
            <Button onClick={handleSaveBilling} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('playerInvoices.billingDialog.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
