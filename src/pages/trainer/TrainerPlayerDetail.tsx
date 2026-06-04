import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { ArrowLeft, FileText, Mail, Phone } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { getTrainerCreateInvoiceUrl } from '@/lib/invoiceCustomer';
import { isTrainerRegisteredPlayerVisible } from '@/lib/invoiceSelectablePlayers';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface PlayerCore {
  full_name: string;
  email: string | null;
  phone: string | null;
  type: 'guest' | 'registered';
  guest_player_id: string | null;
  profile_id: string | null;
}

interface InvoiceItem {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total: number | null;
  status: string | null;
}

export default function TrainerPlayerDetail() {
  const { t } = useTranslation('trainer');
  const { playerId } = useParams<{ playerId: string }>();
  const { user } = useAuth();

  const parsed = useMemo(() => {
    if (!playerId) return { kind: null as null | 'guest' | 'profile', id: '' };
    if (playerId.startsWith('g_')) return { kind: 'guest' as const, id: playerId.slice(2) };
    if (playerId.startsWith('p_')) return { kind: 'profile' as const, id: playerId.slice(2) };
    return { kind: null, id: '' };
  }, [playerId]);

  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [player, setPlayer] = useState<PlayerCore | null>(null);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);

  useEffect(() => {
    if (!user?.id) return;
    void supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => setTrainerId(data?.id ?? null));
  }, [user?.id]);

  useEffect(() => {
    if (!parsed.kind || !parsed.id || !trainerId) return;
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed.kind, parsed.id, trainerId]);

  async function loadAll() {
    setLoading(true);
    try {
      let core: PlayerCore | null = null;
      if (parsed.kind === 'guest') {
        const { data } = await supabase
          .from('guest_players')
          .select('id, full_name, email, phone, trainer_id, linked_profile_id')
          .eq('id', parsed.id)
          .maybeSingle();
        if (data && data.trainer_id === trainerId) {
          core = {
            full_name: data.full_name,
            email: data.email,
            phone: data.phone,
            type: 'guest',
            guest_player_id: data.id,
            profile_id: data.linked_profile_id,
          };
        }
      } else if (parsed.kind === 'profile') {
        const visible = await isTrainerRegisteredPlayerVisible(trainerId!, parsed.id);
        if (visible) {
          const { data } = await supabase
            .from('profiles')
            .select('id, full_name, email, phone')
            .eq('id', parsed.id)
            .maybeSingle();
          if (data) {
            core = {
              full_name: (data as { full_name?: string }).full_name || '',
              email: (data as { email?: string | null }).email ?? null,
              phone: (data as { phone?: string | null }).phone ?? null,
              type: 'registered',
              guest_player_id: null,
              profile_id: (data as { id: string }).id,
            };
          }
        }
      }
      setPlayer(core);
      if (!core) {
        setInvoices([]);
        return;
      }

      const invQuery =
        parsed.kind === 'guest'
          ? supabase
              .from('invoices')
              .select('id, invoice_number, invoice_date, due_date, total, status')
              .eq('guest_player_id', parsed.id)
              .eq('trainer_id', trainerId!)
              .order('invoice_date', { ascending: false })
          : supabase
              .from('invoices')
              .select('id, invoice_number, invoice_date, due_date, total, status')
              .eq('player_id', parsed.id)
              .eq('trainer_id', trainerId!)
              .order('invoice_date', { ascending: false });
      const { data: invs } = await invQuery;
      setInvoices((invs || []) as InvoiceItem[]);
    } catch (err) {
      logger.error('Error loading trainer player detail', err as Error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!player || !playerId) {
    return (
      <div className="p-6">
        <Link
          to="/app/trainer/players"
          className="inline-flex items-center text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t('players.detail.back', 'Back to players')}
        </Link>
        <p className="mt-4 text-muted-foreground">{t('players.detail.notFound', 'Player not found')}</p>
      </div>
    );
  }

  const initials = player.full_name
    .split(' ')
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <Link
        to="/app/trainer/players"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        {t('players.detail.back', 'Back to players')}
      </Link>

      <Card>
        <CardContent className="p-6 flex flex-col md:flex-row gap-6 md:items-center">
          <Avatar className="h-20 w-20 shrink-0">
            <AvatarFallback className="text-xl">{initials || '?'}</AvatarFallback>
          </Avatar>
          <div className="flex-1 space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{player.full_name}</h1>
              <Badge variant="outline">
                {player.type === 'registered'
                  ? t('players.detail.registered', 'Registered')
                  : t('players.detail.guest', 'Guest')}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              {player.email && (
                <a href={`mailto:${player.email}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <Mail className="h-3.5 w-3.5" /> {player.email}
                </a>
              )}
              {player.phone && (
                <a href={`tel:${player.phone}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <Phone className="h-3.5 w-3.5" /> {player.phone}
                </a>
              )}
            </div>
          </div>
          <div className="shrink-0 md:self-start">
            <Button asChild data-testid="trainer-player-create-invoice">
              <Link to={getTrainerCreateInvoiceUrl(playerId)}>
                <FileText className="h-4 w-4 mr-2" />
                {t('players.detail.createInvoice', 'Create invoice')}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="px-6 py-4 border-b">
            <h2 className="text-lg font-medium">
              {t('players.detail.tabs.invoices', 'Invoices')} ({invoices.length})
            </h2>
          </div>
          {invoices.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {t('players.detail.noInvoices', 'No invoices yet.')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('players.detail.invoiceNumber', 'Invoice')}</TableHead>
                  <TableHead>{t('players.detail.invoiceDate', 'Date')}</TableHead>
                  <TableHead>{t('players.detail.invoiceDue', 'Due')}</TableHead>
                  <TableHead>{t('players.detail.invoiceStatus', 'Status')}</TableHead>
                  <TableHead className="text-right">{t('players.detail.invoiceTotal', 'Total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>{inv.invoice_number || '—'}</TableCell>
                    <TableCell>
                      {inv.invoice_date ? format(new Date(inv.invoice_date), 'dd-MM-yyyy') : '—'}
                    </TableCell>
                    <TableCell>
                      {inv.due_date ? format(new Date(inv.due_date), 'dd-MM-yyyy') : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{inv.status || '—'}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {inv.total != null ? `€${Number(inv.total).toFixed(2)}` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
