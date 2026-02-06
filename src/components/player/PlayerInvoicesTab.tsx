import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import {
  FileText,
  Download,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Pencil,
} from 'lucide-react';
import { format, parseISO, isAfter } from 'date-fns';
import { nl } from 'date-fns/locale';

interface PlayerInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  player_name: string;
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
}

interface PlayerInvoicesTabProps {
  profileId: string;
}

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: React.ComponentType<{ className?: string }> }> = {
  draft: { label: 'Concept', variant: 'secondary', icon: FileText },
  sent: { label: 'Verzonden', variant: 'default', icon: Clock },
  paid: { label: 'Betaald', variant: 'outline', icon: CheckCircle2 },
  overdue: { label: 'Verlopen', variant: 'destructive', icon: AlertCircle },
};

export function PlayerInvoicesTab({ profileId }: PlayerInvoicesTabProps) {
  const { toast } = useToast();
  const [invoices, setInvoices] = useState<PlayerInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadLoading, setDownloadLoading] = useState<string | null>(null);
  const [editingInvoice, setEditingInvoice] = useState<PlayerInvoice | null>(null);
  const [billingAddress, setBillingAddress] = useState('');
  const [billingBtw, setBillingBtw] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchInvoices();
  }, [profileId]);

  const fetchInvoices = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, invoice_date, due_date, player_name, player_address, player_btw_number, subtotal, vat_rate, vat_amount, total, status, pdf_url, sent_at, paid_at, notes')
      .eq('player_id', profileId)
      .order('invoice_date', { ascending: false });

    if (error) {
      console.error('Error fetching player invoices:', error);
      toast({ title: 'Fout', description: 'Kon facturen niet laden', variant: 'destructive' });
    } else {
      const now = new Date();
      const processed = (data || []).map(inv => {
        if (inv.status === 'sent' && isAfter(now, parseISO(inv.due_date))) {
          return { ...inv, status: 'overdue' };
        }
        return inv;
      }) as PlayerInvoice[];
      setInvoices(processed);
    }
    setLoading(false);
  };

  const handleDownload = async (invoice: PlayerInvoice) => {
    if (!invoice.pdf_url) {
      setDownloadLoading(invoice.id);
      const { data, error } = await supabase.functions.invoke('generate-invoice', {
        body: { invoiceId: invoice.id },
      });

      if (error || !data?.pdfUrl) {
        toast({ title: 'Fout', description: 'Kon PDF niet genereren', variant: 'destructive' });
        setDownloadLoading(null);
        return;
      }

      window.open(data.pdfUrl, '_blank');
      setDownloadLoading(null);
      fetchInvoices();
    } else {
      window.open(invoice.pdf_url, '_blank');
    }
  };

  const openEditBilling = (invoice: PlayerInvoice) => {
    setEditingInvoice(invoice);
    setBillingAddress(invoice.player_address || '');
    setBillingBtw(invoice.player_btw_number || '');
  };

  const handleSaveBilling = async () => {
    if (!editingInvoice) return;
    setSaving(true);

    const { error } = await supabase
      .from('invoices')
      .update({
        player_address: billingAddress || null,
        player_btw_number: billingBtw || null,
      } as any)
      .eq('id', editingInvoice.id);

    if (error) {
      toast({ title: 'Fout', description: 'Kon gegevens niet opslaan', variant: 'destructive' });
    } else {
      toast({ title: 'Opgeslagen', description: 'Je facturatiegegevens zijn bijgewerkt' });
      setEditingInvoice(null);
      fetchInvoices();
    }
    setSaving(false);
  };

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

  if (invoices.length === 0) {
    return (
      <Card className="p-12 text-center">
        <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-xl font-semibold mb-2">Geen facturen</h3>
        <p className="text-muted-foreground">
          Je hebt nog geen facturen ontvangen van trainers.
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {invoices.map((invoice) => (
          <Card key={invoice.id}>
            <CardContent className="p-4 sm:p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold font-mono">{invoice.invoice_number}</p>
                    {getStatusBadge(invoice.status)}
                  </div>
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
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEditBilling(invoice)}
                      title="Facturatiegegevens bewerken"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDownload(invoice)}
                      disabled={downloadLoading === invoice.id}
                      title="Download PDF"
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
            <DialogTitle>Facturatiegegevens bewerken</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="billing-address">Adres</Label>
              <Textarea
                id="billing-address"
                value={billingAddress}
                onChange={(e) => setBillingAddress(e.target.value)}
                placeholder="Straatnaam 123&#10;1234 AB Amsterdam"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billing-btw">BTW-nummer</Label>
              <Input
                id="billing-btw"
                value={billingBtw}
                onChange={(e) => setBillingBtw(e.target.value)}
                placeholder="NL123456789B01"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingInvoice(null)}>
              Annuleren
            </Button>
            <Button onClick={handleSaveBilling} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Opslaan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
