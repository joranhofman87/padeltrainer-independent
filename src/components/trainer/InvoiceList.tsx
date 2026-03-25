import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { InvoiceEmailDialog } from './InvoiceEmailDialog';
import { EditInvoiceDialog } from '@/components/invoices/EditInvoiceDialog';
import { 
  FileText, 
  Download, 
  Send, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Loader2,
  Euro,
  Trash2,
  Eye,
  Mail,
  Pencil,
  Users
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { format, parseISO, isAfter } from 'date-fns';
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
  line_items: any;
  booking_ids: string[] | null;
  notes: string | null;
}

interface InvoiceListProps {
  trainerId: string;
  refreshTrigger?: number;
  forwardEmails?: string[];
}

type StatusFilter = 'all' | 'draft' | 'sent' | 'paid' | 'overdue';

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: React.ComponentType<{ className?: string }> }> = {
  draft: { label: 'Concept', variant: 'secondary', icon: FileText },
  sent: { label: 'Verzonden', variant: 'default', icon: Clock },
  paid: { label: 'Betaald', variant: 'outline', icon: CheckCircle2 },
  overdue: { label: 'Verlopen', variant: 'destructive', icon: AlertCircle },
  cancelled: { label: 'Geannuleerd', variant: 'secondary', icon: AlertCircle },
};

export function InvoiceList({ trainerId, refreshTrigger, forwardEmails = [] }: InvoiceListProps) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; invoiceId: string; playerName: string; guestPlayerId: string | null }>({ open: false, invoiceId: '', playerName: '', guestPlayerId: null });
  const [editInvoice, setEditInvoice] = useState<Invoice | null>(null);
  const [splitConfirm, setSplitConfirm] = useState<{ open: boolean; invoiceId: string }>({ open: false, invoiceId: '' });

  useEffect(() => {
    fetchInvoices();
  }, [trainerId, refreshTrigger]);

  const fetchInvoices = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('trainer_id', trainerId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching invoices', error instanceof Error ? error : new Error(String(error)), { component: 'InvoiceList' });
      toast({
        title: 'Fout',
        description: 'Kon facturen niet laden',
        variant: 'destructive',
      });
    } else {
      const now = new Date();
      const processedInvoices = (data || []).map(inv => {
        if (inv.status === 'sent' && isAfter(now, parseISO(inv.due_date))) {
          return { ...inv, status: 'overdue' };
        }
        return inv;
      });
      setInvoices(processedInvoices as Invoice[]);
    }
    setLoading(false);
  };

  const handleMarkPaid = async (invoiceId: string) => {
    setActionLoading(invoiceId);
    const { error } = await supabase
      .from('invoices')
      .update({ 
        status: 'paid', 
        paid_at: new Date().toISOString() 
      })
      .eq('id', invoiceId);

    if (error) {
      toast({
        title: 'Fout',
        description: 'Kon status niet bijwerken',
        variant: 'destructive',
      });
    } else {
      toast({ title: 'Factuur gemarkeerd als betaald' });
      if (forwardEmails.length > 0) {
        supabase.functions.invoke('forward-invoice', { body: { invoiceId } }).catch(err => logger.error('Forward invoice failed', err instanceof Error ? err : new Error(String(err)), { component: 'InvoiceList' }));
      }
      fetchInvoices();
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
          title: 'Fout',
          description: 'Kon factuur niet verzenden',
          variant: 'destructive',
        });
      } else {
        const emailMsg = data?.email ? ` naar ${data.email}` : '';
        toast({ title: 'Factuur verzonden', description: `De factuur is verzonden${emailMsg}` });
        fetchInvoices();
      }
    } catch (err) {
      toast({
        title: 'Fout',
        description: 'Kon factuur niet verzenden',
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
    const { data } = await supabase.functions.invoke('send-invoice-email', {
      body: { invoiceId },
    });

    // Mark as sent
    await supabase.from('invoices').update({ 
      status: 'sent', 
      sent_at: new Date().toISOString() 
    }).eq('id', invoiceId);

    // Generate PDF
    supabase.functions.invoke('generate-invoice', { body: { invoiceId } }).catch(() => {});

    const emailMsg = data?.email ? ` naar ${data.email}` : ` naar ${email}`;
    toast({ title: 'Factuur verzonden', description: `De factuur is verzonden${emailMsg}` });
    fetchInvoices();
  };

  const handleDownload = async (invoice: Invoice) => {
    setActionLoading(invoice.id);
    const { data, error } = await supabase.functions.invoke('generate-invoice', {
      body: { invoiceId: invoice.id },
    });

    if (error || !data?.html) {
      toast({
        title: 'Fout',
        description: 'Kon factuur niet genereren',
        variant: 'destructive',
      });
      setActionLoading(null);
      return;
    }

    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(data.html);
      printWindow.document.close();
      printWindow.onload = () => printWindow.print();
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

  const handleDelete = async (invoiceId: string) => {
    if (!confirm('Weet je zeker dat je dit concept wilt verwijderen?')) return;
    
    setActionLoading(invoiceId);
    const { error } = await supabase
      .from('invoices')
      .delete()
      .eq('id', invoiceId);

    if (error) {
      toast({
        title: 'Fout',
        description: 'Kon factuur niet verwijderen',
        variant: 'destructive',
      });
    } else {
      toast({ title: 'Concept verwijderd' });
      fetchInvoices();
    }
    setActionLoading(null);
  };

  const handleSplitInvoice = async (invoiceId: string) => {
    setSplitConfirm({ open: false, invoiceId: '' });
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
        fetchInvoices();
      }
    } catch {
      toast({ title: 'Fout', description: 'Kon factuur niet splitsen', variant: 'destructive' });
    }
    setActionLoading(null);
  };

  const filteredInvoices = invoices.filter(inv => {
    if (statusFilter === 'all') return true;
    return inv.status === statusFilter;
  });

  const getStatusBadge = (status: string) => {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.draft;
    const Icon = config.icon;
    return (
      <Badge variant={config.variant} className="gap-1">
        <Icon className="h-3 w-3" />
        {config.label}
      </Badge>
    );
  };

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
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter op status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle facturen</SelectItem>
            <SelectItem value="draft">Concepten</SelectItem>
            <SelectItem value="sent">Verzonden</SelectItem>
            <SelectItem value="paid">Betaald</SelectItem>
            <SelectItem value="overdue">Verlopen</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          {filteredInvoices.length} facturen
        </p>
      </div>

      {/* Invoice List */}
      {filteredInvoices.length === 0 ? (
        <Card className="p-8 text-center">
          <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="font-semibold text-lg mb-2">
            {statusFilter === 'all' ? 'Nog geen facturen' : `Geen ${STATUS_CONFIG[statusFilter]?.label.toLowerCase() || statusFilter} facturen`}
          </h3>
          <p className="text-muted-foreground">
            Maak je eerste factuur aan via de pending payments tab.
          </p>
        </Card>
      ) : (
        filteredInvoices.map((invoice) => (
          <Card key={invoice.id}>
            <CardContent className="p-4 sm:p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold font-mono">{invoice.invoice_number}</p>
                    {getStatusBadge(invoice.status)}
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
                  </div>
                </div>
                
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-xl font-bold">€{invoice.total.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">
                      incl. {invoice.vat_rate}% BTW
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-1">
                    {invoice.status === 'draft' && (
                      <>
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
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(invoice.id)}
                          disabled={actionLoading === invoice.id}
                          title="Verwijderen"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </>
                    )}
                    
                    {invoice.status !== 'paid' && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleMarkPaid(invoice.id)}
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
                          size="icon"
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

                    {invoice.status === 'paid' && forwardEmails.length > 0 && (
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
                    
                    <Button
                      variant="ghost"
                      size="icon"
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

      <AlertDialog open={splitConfirm.open} onOpenChange={(open) => !open && setSplitConfirm({ open: false, invoiceId: '' })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Factuur splitsen over spelers</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je deze factuur wilt splitsen over alle spelers? De huidige factuur wordt aangepast (bedragen gedeeld door het aantal spelers) en er worden nieuwe facturen aangemaakt voor de andere spelers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleSplitInvoice(splitConfirm.invoiceId)}>
              Splitsen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
