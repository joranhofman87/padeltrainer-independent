import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/empty-state';
import { Card, CardContent } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { SelectFilter } from '@/components/ui/select-filter';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { fetchAllRows } from '@/lib/supabasePaging';
import { deleteOrCancelInvoices } from '@/lib/invoices';
import { logger } from '@/lib/logger';
import { formatCurrency } from '@/lib/format';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { markInvoicePaidAndSyncBookings } from '@/lib/markInvoicePaid';
import { deriveInvoiceStatus, type InvoiceStatus } from '@/lib/invoiceStatus';
import { InvoiceStatusBadge } from '@/components/invoices/InvoiceStatusBadge';
import { InvoiceDeliveryChip } from '@/components/email/InvoiceDeliveryChip';
import { useInvoicesDeliveryStatus } from '@/lib/emailBounce';
import { InvoiceEmailDialog } from '@/components/invoices/InvoiceEmailDialog';
import { EditInvoiceDialog } from '@/components/invoices/EditInvoiceDialog';
import {
  FileText,
  Download,
  Send,
  CheckCircle2,
  Loader2,
  Trash2,
  Mail,
  Pencil,
  Users
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { format, parseISO } from 'date-fns';
import { nl } from 'date-fns/locale';

interface Invoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  player_name: string;
  guest_player_id: string | null;
  subtotal: number;
  vat_rate: number;
  vat_amount: number;
  total: number;
  status: string;
  pdf_url: string | null;
  sent_at: string | null;
  paid_at: string | null;
  forwarded_at: string | null;
  line_items: any;
  booking_ids: string[] | null;
  notes: string | null;
  prices_include_vat?: boolean;
  player_business_name?: string;
  player_address?: string;
  player_btw_number?: string;
}

interface InvoiceListProps {
  trainerId: string;
  refreshTrigger?: number;
  forwardEmails?: string[];
  isAdmin?: boolean;
}

type StatusFilter = 'all' | 'draft' | 'sent' | 'paid' | 'overdue';

export function InvoiceList({ trainerId, refreshTrigger, forwardEmails = [], isAdmin = false }: InvoiceListProps) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; invoiceId: string; playerName: string; guestPlayerId: string | null }>({ open: false, invoiceId: '', playerName: '', guestPlayerId: null });
  const [editInvoice, setEditInvoice] = useState<Invoice | null>(null);
  const [splitConfirm, setSplitConfirm] = useState<{ open: boolean; invoiceId: string }>({ open: false, invoiceId: '' });
  // One confirm for both trash buttons (admin void + regular delete): the two raw
  // dialogs were byte-identical (same copy, same removeInvoice call).
  const [removeConfirm, setRemoveConfirm] = useState<{ open: boolean; invoice: Invoice | null }>({ open: false, invoice: null });

  // Per-invoice delivery flag (no email / bounced / failed) — same signal as the
  // dedicated invoice pages, via the authorized batch RPC that resolves the
  // recipient email server-side (a client read of profiles.email is RLS-blocked).
  const { data: deliveryInfo } = useInvoicesDeliveryStatus(invoices.map((i) => i.id));

  useEffect(() => {
    fetchInvoices();
  }, [trainerId, refreshTrigger]);

  const fetchInvoices = async () => {
    setLoading(true);
    try {
      // Page the FULL set to completion: PostgREST silently caps a plain select at
      // 1000 rows, so a high-volume trainer would lose their oldest invoices with no
      // error (the same money-path truncation supabasePaging exists to prevent). The
      // rows/order are unchanged; `id` is the stable tiebreaker range paging requires.
      const data = await fetchAllRows<Invoice>(
        () =>
          supabase
            .from('invoices')
            .select('*')
            .eq('trainer_id', trainerId)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false }) as unknown as {
            range: (from: number, to: number) => PromiseLike<{ data: Invoice[] | null; error: unknown }>;
          },
      );
      const now = new Date();
      // Persist the derived status (e.g. sent + past-due → overdue) so the
      // status filter and badge agree. Single source of truth: deriveInvoiceStatus.
      const processedInvoices = data.map(inv => ({
        ...inv,
        status: deriveInvoiceStatus(inv, now),
      }));
      setInvoices(processedInvoices as Invoice[]);
    } catch (error) {
      logger.error('Error fetching invoices', error instanceof Error ? error : new Error(String(error)), { component: 'InvoiceList' });
      toast({
        title: 'Fout',
        description: 'Kon facturen niet laden',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  /** After any invoice/guest write: refresh list + all player views (overdue flag, email). */
  const refreshAfterInvoiceWrite = () => {
    invalidateAllPlayerData(queryClient, { kind: 'trainer', id: trainerId });
    fetchInvoices();
  };

  const handleMarkPaid = async (invoice: Invoice) => {
    if (invoice.status === 'cancelled') {
      toast({
        title: t('invoices.markPaidBlockedTitle', 'Niet mogelijk'),
        description: t('invoices.cancelledCannotBePaid', 'Een geannuleerde factuur kan niet als betaald worden gemarkeerd.'),
        variant: 'destructive',
      });
      return;
    }
    setActionLoading(invoice.id);
    // Single source of truth: flips the invoice to paid AND syncs the linked
    // bookings (payment_status='paid', status='confirmed', paid_at) so trainer,
    // academy and player surfaces all agree.
    const { error, blockedCancelled, invoicePaid } = await markInvoicePaidAndSyncBookings(
      invoice.id,
      invoice.booking_ids,
    );

    if (blockedCancelled) {
      toast({
        title: t('invoices.markPaidBlockedTitle', 'Niet mogelijk'),
        description: t('invoices.cancelledCannotBePaid', 'Een geannuleerde factuur kan niet als betaald worden gemarkeerd.'),
        variant: 'destructive',
      });
    } else if (error && !invoicePaid) {
      toast({
        title: 'Fout',
        description: 'Kon status niet bijwerken',
        variant: 'destructive',
      });
    } else {
      // Invoice is paid; surface a distinct warning if only the booking sync failed.
      if (error && invoicePaid) {
        logger.error('Mark paid: booking sync failed', error, { component: 'InvoiceList' });
        toast({
          title: t('invoices.markPaidBookingSyncFailedTitle', 'Let op'),
          description: t('invoices.markPaidBookingSyncFailed', 'Factuur is als betaald gemarkeerd, maar de gekoppelde boekingen konden niet worden bijgewerkt.'),
          variant: 'destructive',
        });
      }
      toast({ title: 'Factuur gemarkeerd als betaald' });
      if (forwardEmails.length > 0) {
        supabase.functions.invoke('forward-invoice', { body: { invoiceId: invoice.id } }).catch(err => logger.error('Forward invoice failed', err instanceof Error ? err : new Error(String(err)), { component: 'InvoiceList' }));
      }
      refreshAfterInvoiceWrite();
    }
    setActionLoading(null);
  };

  const handleSendInvoice = async (invoice: Invoice) => {
    setActionLoading(invoice.id);

    try {
      // Call edge function to send email
      const { data, error: fnError } = await supabase.functions.invoke('send-invoice-email', {
        body: { invoiceId: invoice.id },
      });

      if (fnError) {
        logger.error('Send invoice email error', fnError instanceof Error ? fnError : new Error(String(fnError)), { component: 'InvoiceList' });
      }

      if (data?.error === 'no_email') {
        // Show email dialog
        setEmailDialog({ open: true, invoiceId: invoice.id, playerName: invoice.player_name, guestPlayerId: invoice.guest_player_id });
        setActionLoading(null);
        return;
      }

      // Only stamp sent_at/status after a confirmed delivery — a failed send
      // must not record the invoice as issued.
      if (fnError || !data?.success) {
        toast({
          title: t('invoices.sendError'),
          description: t('invoices.sendError'),
          variant: 'destructive',
        });
        setActionLoading(null);
        return;
      }

      // Generate PDF if needed
      const { error: genError } = await supabase.functions.invoke('generate-invoice', {
        body: { invoiceId: invoice.id },
      });
      if (genError) {
        logger.error('PDF generation error', genError instanceof Error ? genError : new Error(String(genError)), { component: 'InvoiceList' });
      }

      // Update status to sent
      const { error } = await supabase
        .from('invoices')
        .update({ 
          status: 'sent', 
          sent_at: new Date().toISOString() 
        })
        .eq('id', invoice.id);

      if (error) {
        toast({
          title: t('invoices.sendError'),
          description: t('invoices.sendError'),
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('invoices.sentSuccess'),
          description: data?.email
            ? t('invoices.sentSuccessTo', { email: data.email })
            : t('invoices.sentSuccess'),
        });
        refreshAfterInvoiceWrite();
      }
    } catch {
      toast({
        title: t('invoices.sendError'),
        description: t('invoices.sendError'),
        variant: 'destructive',
      });
    }
    setActionLoading(null);
  };

  const handleEmailSubmitAndSend = async (email: string) => {
    const { invoiceId, guestPlayerId } = emailDialog;

    // Save email to guest player
    if (guestPlayerId) {
      await supabase.from('guest_players').update({ email }).eq('id', guestPlayerId);
    }

    // Retry sending
    const { data, error: fnError } = await supabase.functions.invoke('send-invoice-email', {
      body: { invoiceId },
    });

    // Only mark sent after a confirmed delivery
    if (fnError || !data?.success) {
      toast({
        title: t('invoices.sendError'),
        description: t('invoices.sendError'),
        variant: 'destructive',
      });
      return;
    }

    await supabase.from('invoices').update({
      status: 'sent',
      sent_at: new Date().toISOString()
    }).eq('id', invoiceId);

    // Generate PDF
    supabase.functions.invoke('generate-invoice', { body: { invoiceId } }).catch(() => {});

    const emailMsg = data?.email ? ` naar ${data.email}` : ` naar ${email}`;
    toast({ title: 'Factuur verzonden', description: `De factuur is verzonden${emailMsg}` });
    refreshAfterInvoiceWrite();
  };

  const handleDownload = async (invoice: Invoice) => {
    setActionLoading(invoice.id);
    const { downloadInvoicePdf } = await import('@/lib/downloadInvoicePdf');
    const ok = await downloadInvoicePdf(invoice.id, invoice.invoice_number);
    if (!ok) {
      toast({
        title: 'Fout',
        description: 'Kon factuur niet genereren',
        variant: 'destructive',
      });
    }
    setActionLoading(null);
  };

  const handleForwardInvoice = async (invoiceId: string) => {
    setActionLoading(invoiceId);
    const { error } = await supabase.functions.invoke('forward-invoice', {
      body: { invoiceId },
    });
    if (error) {
      toast({ title: 'Fout', description: 'Kon factuur niet doorsturen', variant: 'destructive' });
    } else {
      toast({ title: 'Factuur doorgestuurd', description: `Verzonden naar ${forwardEmails.length} adres(sen)` });
    }
    setActionLoading(null);
  };

  // Draft → hard-delete; anything else → soft-cancel (audit trail). The facade
  // owns that partition so a paid invoice can never be hard-deleted here.
  const removeInvoice = async (invoice: Invoice) => {
    const { refusedIds, deleteError, cancelError } = await deleteOrCancelInvoices([invoice]);
    if (refusedIds.length) {
      // a paid invoice is refused by the facade: cancelling one is not a refund
      toast({
        title: 'Betaalde factuur',
        description: 'Een betaalde factuur kan niet geannuleerd worden — maak een terugbetaling of creditnota.',
        variant: 'destructive',
      });
      return;
    }
    if (deleteError || cancelError) {
      toast({
        title: 'Fout',
        description: invoice.status === 'draft' ? 'Kon factuur niet verwijderen' : 'Kon factuur niet annuleren',
        variant: 'destructive',
      });
    } else {
      toast({ title: invoice.status === 'draft' ? 'Factuur verwijderd' : 'Factuur geannuleerd' });
      refreshAfterInvoiceWrite();
    }
  };

  const handleRemoveInvoice = async (invoice: Invoice) => {
    setActionLoading(invoice.id);
    try {
      await removeInvoice(invoice);
    } finally {
      setActionLoading(null);
      setRemoveConfirm({ open: false, invoice: null });
    }
  };

  const handleSplitInvoice = async (invoiceId: string) => {
    setActionLoading(invoiceId);
    try {
      const { data, error } = await supabase.functions.invoke('split-invoice', {
        body: { invoiceId },
      });
      if (error || data?.error) {
        const msg = data?.error === 'no_other_players' 
          ? 'Er zijn geen andere spelers om mee te splitsen'
          : (data?.message || 'Kon factuur niet splitsen');
        toast({ title: 'Fout', description: msg, variant: 'destructive' });
      } else {
        toast({ 
          title: 'Factuur gesplitst', 
          description: `Gesplitst over ${data.totalPlayers} spelers. ${data.createdInvoices?.length || 0} nieuwe facturen aangemaakt.`
        });
        refreshAfterInvoiceWrite();
      }
    } catch {
      toast({ title: 'Fout', description: 'Kon factuur niet splitsen', variant: 'destructive' });
    }
    setActionLoading(null);
    setSplitConfirm({ open: false, invoiceId: '' });
  };

  const filteredInvoices = invoices.filter(inv => {
    if (statusFilter === 'all') return true;
    return inv.status === statusFilter;
  });

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex items-center justify-between">
        <SelectFilter
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          allLabel="Alle facturen"
          options={[
            { value: 'draft', label: 'Concepten' },
            { value: 'sent', label: 'Verzonden' },
            { value: 'paid', label: 'Betaald' },
            { value: 'overdue', label: 'Verlopen' },
          ]}
          placeholder="Filter op status"
          triggerClassName="w-[180px]"
        />
        <p className="text-sm text-muted-foreground">
          {filteredInvoices.length} facturen
        </p>
      </div>

      {/* Invoice List */}
      {filteredInvoices.length === 0 ? (
        <Card className={flushOnMobileCardClass()}>
          <EmptyState
            icon={FileText}
            variant="trainer"
            title={statusFilter === 'all'
              ? t('invoiceList.emptyTitle', 'Nog geen facturen')
              : t('invoiceList.emptyFilteredTitle', 'Geen {{status}} facturen', { status: t(`invoiceStatus.${statusFilter}`, { ns: 'common' }).toLowerCase() })}
            description={t('invoiceList.emptyDescription', 'Maak je eerste factuur aan via de openstaande betalingen.')}
          />
        </Card>
      ) : (
        filteredInvoices.map((invoice) => (
          <Card key={invoice.id} className={flushOnMobileCardClass()}>
            <CardContent className="p-4 sm:p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold font-mono">{invoice.invoice_number}</p>
                    <InvoiceStatusBadge status={invoice.status as InvoiceStatus} />
                    {deliveryInfo?.[invoice.id] && (
                      <InvoiceDeliveryChip
                        deliveryStatus={deliveryInfo[invoice.id].status}
                        hasEmail={deliveryInfo[invoice.id].linkedEmail != null}
                      />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{invoice.player_name}</p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-muted-foreground">
                    <span>
                      Datum: {format(parseISO(invoice.invoice_date), 'd MMM yyyy', { locale: nl })}
                    </span>
                    <span className={invoice.status === 'overdue' ? 'text-destructive' : ''}>
                      Vervalt: {format(parseISO(invoice.due_date), 'd MMM yyyy', { locale: nl })}
                    </span>
                    {invoice.paid_at && (
                      <span className="text-green-600">
                        Betaald: {format(parseISO(invoice.paid_at), 'd MMM yyyy', { locale: nl })}
                      </span>
                    )}
                    {invoice.forwarded_at && (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Mail className="h-3 w-3" />
                        Doorgestuurd: {format(parseISO(invoice.forwarded_at), 'd MMM yyyy', { locale: nl })}
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-xl font-bold">{formatCurrency(invoice.total)}</p>
                    <p className="text-xs text-muted-foreground">
                      incl. {invoice.vat_rate}% BTW
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-1">
                    {invoice.status === 'draft' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleSendInvoice(invoice)}
                        disabled={actionLoading === invoice.id}
                        title="Verstuur factuur"
                      >
                        {actionLoading === invoice.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                      </Button>
                    )}

                    {invoice.status !== 'cancelled' && (
                      <Button
                        variant="ghost"
                        size="icon" aria-label="Delete"
                        onClick={() => setRemoveConfirm({ open: true, invoice })}
                        disabled={actionLoading === invoice.id}
                        title={invoice.status === 'draft' ? 'Verwijderen' : 'Annuleren'}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                    
                    {invoice.status !== 'paid' && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleMarkPaid(invoice)}
                          disabled={actionLoading === invoice.id}
                          title="Markeer als betaald"
                        >
                          {actionLoading === invoice.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon" aria-label="Edit"
                          onClick={() => setEditInvoice(invoice)}
                          title="Bewerken"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {invoice.booking_ids && invoice.booking_ids.length > 0 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSplitConfirm({ open: true, invoiceId: invoice.id })}
                            disabled={actionLoading === invoice.id}
                            title="Split over spelers"
                          >
                            <Users className="h-4 w-4" />
                          </Button>
                        )}
                      </>
                    )}

                    {invoice.status === 'paid' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleForwardInvoice(invoice.id)}
                        disabled={actionLoading === invoice.id}
                        title="Doorsturen naar boekhouding"
                      >
                        {actionLoading === invoice.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Mail className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                    
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="icon" aria-label="Delete"
                        onClick={() => setRemoveConfirm({ open: true, invoice })}
                        disabled={actionLoading === invoice.id}
                        title={invoice.status === 'draft' ? 'Verwijderen (admin)' : 'Annuleren (admin)'}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                    
                    <Button
                      variant="ghost"
                      size="icon" aria-label="Download"
                      onClick={() => handleDownload(invoice)}
                      disabled={actionLoading === invoice.id}
                      title="Download PDF"
                    >
                      {actionLoading === invoice.id ? (
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
        ))
      )}

      <InvoiceEmailDialog
        open={emailDialog.open}
        onClose={() => setEmailDialog({ open: false, invoiceId: '', playerName: '', guestPlayerId: null })}
        playerName={emailDialog.playerName}
        onSubmit={handleEmailSubmitAndSend}
      />

      <EditInvoiceDialog
        open={!!editInvoice}
        onClose={() => setEditInvoice(null)}
        invoice={editInvoice}
        onSaved={() => fetchInvoices()}
        trainerId={trainerId}
      />

      <ConfirmDialog
        open={splitConfirm.open}
        onOpenChange={(open) => !open && setSplitConfirm({ open: false, invoiceId: '' })}
        title="Factuur splitsen over spelers"
        description="Weet je zeker dat je deze factuur wilt splitsen over alle spelers? De huidige factuur wordt aangepast (bedragen gedeeld door het aantal spelers) en er worden nieuwe facturen aangemaakt voor de andere spelers."
        confirmLabel="Splitsen"
        cancelLabel="Annuleren"
        variant="default"
        loading={!!actionLoading && actionLoading === splitConfirm.invoiceId}
        onConfirm={() => handleSplitInvoice(splitConfirm.invoiceId)}
      />
      <ConfirmDialog
        open={removeConfirm.open}
        onOpenChange={(open) => !open && setRemoveConfirm({ open: false, invoice: null })}
        title={removeConfirm.invoice?.status === 'draft' ? 'Factuur verwijderen' : 'Factuur annuleren'}
        description={removeConfirm.invoice?.status === 'draft'
          ? `Weet je zeker dat je factuur ${removeConfirm.invoice?.invoice_number} wilt verwijderen? Dit kan niet ongedaan worden gemaakt.`
          : `Weet je zeker dat je factuur ${removeConfirm.invoice?.invoice_number} wilt annuleren? De factuur wordt gemarkeerd als geannuleerd.`
        }
        confirmLabel={removeConfirm.invoice?.status === 'draft' ? 'Verwijderen' : 'Annuleren'}
        cancelLabel="Annuleren"
        loading={!!removeConfirm.invoice && actionLoading === removeConfirm.invoice.id}
        onConfirm={() => {
          if (removeConfirm.invoice) return handleRemoveInvoice(removeConfirm.invoice);
        }}
      />
    </div>
  );
}
