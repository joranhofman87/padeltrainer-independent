import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Mail, User } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getAcademyPlayerProfilePath,
  getInvoiceRecipientKind,
  getTrainerPlayerProfilePath,
  type InvoiceDetailOwner,
} from '@/lib/invoiceRecipient';

export interface InvoiceRecipientCardProps {
  owner: InvoiceDetailOwner;
  playerName: string;
  playerId?: string | null;
  guestPlayerId?: string | null;
  invoiceId?: string | null;
}

// Resolve the recipient email through the ownership-gated RPC, which applies the
// FAM-02 rule (a linked guest's email comes from the parent profile first) — the
// same value the invoice is actually sent to. Reading guest_players.email
// directly showed a stale address after the parent edited their profile.
async function fetchRecipientEmail(
  invoiceId: string | null | undefined,
): Promise<string | null> {
  if (!invoiceId) return null;
  const { data } = await supabase.rpc('get_invoice_recipient_email', { _invoice_id: invoiceId });
  return (typeof data === 'string' ? data.trim() : '') || null;
}

export function InvoiceRecipientCard({
  owner,
  playerName,
  playerId,
  guestPlayerId,
  invoiceId,
}: InvoiceRecipientCardProps) {
  const { t } = useTranslation('common');
  const kind = getInvoiceRecipientKind(playerId, guestPlayerId);

  const { data: email, isLoading: emailLoading } = useQuery({
    queryKey: ['invoice-recipient-email', invoiceId],
    queryFn: () => fetchRecipientEmail(invoiceId),
    enabled: !!invoiceId,
  });

  const profilePath =
    owner === 'academy'
      ? getAcademyPlayerProfilePath(playerId, guestPlayerId)
      : getTrainerPlayerProfilePath(playerId, guestPlayerId);

  const typeLabel =
    kind === 'registered'
      ? t('invoiceEdit.recipient.registered', 'Registered Player')
      : kind === 'guest'
        ? t('invoiceEdit.recipient.guest', 'Guest Player')
        : t('invoiceEdit.recipient.manual', 'Manual Recipient');

  const profileButtonLabel =
    owner === 'academy'
      ? t('invoiceEdit.recipient.openProfile', 'Open Player Profile')
      : t('invoiceEdit.recipient.openProfile', 'Open Player Profile');

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <User className="h-4 w-4" />
          {t('invoiceEdit.recipient.title', 'Recipient')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-[7rem_1fr] sm:gap-x-4">
          <span className="text-muted-foreground">{t('invoiceEdit.recipient.name', 'Name')}</span>
          <span className="font-medium">{playerName || '—'}</span>

          <span className="text-muted-foreground">{t('invoiceEdit.recipient.email', 'Email')}</span>
          <span>
            {emailLoading ? (
              <Skeleton className="h-4 w-40" />
            ) : email ? (
              <a
                href={`mailto:${email}`}
                className="inline-flex items-center gap-1.5 text-primary hover:underline"
              >
                <Mail className="h-3.5 w-3.5 shrink-0" />
                {email}
              </a>
            ) : playerId ? (
              // Registered players' emails are not readable client-side (RLS);
              // the send-invoice-email function resolves the address server-side.
              <span className="text-muted-foreground">
                {t('invoiceEdit.emailResolvedAtSend', 'Retrieved automatically when sending')}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </span>

          <span className="text-muted-foreground">{t('invoiceEdit.recipient.type', 'Type')}</span>
          <span>
            <Badge variant="secondary">{typeLabel}</Badge>
          </span>
        </div>

        {profilePath && (
          <Button variant="outline" size="sm" asChild aria-label={profileButtonLabel}>
            <Link to={profilePath}>{profileButtonLabel}</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
