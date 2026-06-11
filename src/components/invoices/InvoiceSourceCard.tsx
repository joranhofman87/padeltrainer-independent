import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Calendar, ExternalLink } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  resolveInvoiceSourceFromBookings,
  type InvoiceSourceBookingRow,
  type InvoiceSourceResolved,
} from '@/lib/invoiceSourceFromBookings';
import { resolveAcademyCyclusPricingRoute } from '@/lib/cyclusPricingRoute';
import type { InvoiceDetailOwner } from '@/lib/invoiceRecipient';

export interface InvoiceSourceCardProps {
  owner: InvoiceDetailOwner;
  bookingIds: string[] | null | undefined;
}

async function fetchBookingsForSource(bookingIds: string[]): Promise<InvoiceSourceBookingRow[]> {
  if (!bookingIds.length) return [];
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, slot_id, availability_slots(id, cyclus_id, cyclus_name, start_time, end_time)',
    )
    .in('id', bookingIds);
  if (error) throw error;
  return (data || []) as InvoiceSourceBookingRow[];
}

function SourceTypeBadge({
  resolved,
  t,
}: {
  resolved: Exclude<InvoiceSourceResolved, { kind: 'none' }>;
  t: (key: string, fallback?: string, opts?: { count?: number }) => string;
}) {
  if (resolved.kind === 'cycle') {
    return (
      <Badge variant="outline">
        {t('invoiceEdit.source.cycle', 'Cycle')}
      </Badge>
    );
  }
  if (resolved.kind === 'session') {
    return (
      <Badge variant="outline">
        {t('invoiceEdit.source.session', 'Session')}
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      {t('invoiceEdit.source.multipleSessions', 'Multiple sessions')}
    </Badge>
  );
}

export function InvoiceSourceCard({ owner, bookingIds }: InvoiceSourceCardProps) {
  const { t, i18n } = useTranslation('common');
  const ids = (bookingIds || []).filter(Boolean);
  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  const { data: resolved, isLoading } = useQuery({
    queryKey: ['invoice-source', owner, ids.join(',')],
    queryFn: async () => {
      const bookings = await fetchBookingsForSource(ids);
      return resolveInvoiceSourceFromBookings(bookings);
    },
    enabled: ids.length > 0,
  });

  const [academyCycleHref, setAcademyCycleHref] = useState<string | null>(null);

  useEffect(() => {
    if (resolved?.kind !== 'cycle' || owner !== 'academy') {
      setAcademyCycleHref(null);
      return;
    }
    let cancelled = false;
    void resolveAcademyCyclusPricingRoute(resolved.cyclusId).then((href) => {
      if (!cancelled) setAcademyCycleHref(href);
    });
    return () => {
      cancelled = true;
    };
  }, [resolved, owner]);

  if (!ids.length) return null;
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('invoiceEdit.source.title', 'Source')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (!resolved || resolved.kind === 'none') return null;

  const typeRowLabel = t('invoiceEdit.source.type', 'Type');
  const labelRowLabel = t('invoiceEdit.source.label', 'Label');

  let labelContent: ReactNode;
  let action: ReactNode = null;

  if (resolved.kind === 'cycle') {
    labelContent = <span className="font-medium">{resolved.label}</span>;
    if (owner === 'academy' && academyCycleHref) {
      action = (
        <Button variant="outline" size="sm" asChild aria-label={t('invoiceEdit.source.viewCycle', 'View Cycle')}>
          <Link to={academyCycleHref}>
            <ExternalLink className="h-3.5 w-3.5 mr-2" />
            {t('invoiceEdit.source.viewCycle', 'View Cycle')}
          </Link>
        </Button>
      );
    }
  } else if (resolved.kind === 'session') {
    const when = format(parseISO(resolved.startTime), 'dd MMM yyyy HH:mm', {
      locale: dateLocale,
    });
    labelContent = (
      <span className="font-medium">
        {resolved.label} · {when}
      </span>
    );
    const sessionPath =
      owner === 'academy'
        ? `/app/academy/slot/${resolved.slotId}`
        : `/app/trainer/slot/${resolved.slotId}`;
    action = (
      <Button variant="outline" size="sm" asChild aria-label={t('invoiceEdit.source.viewSession', 'View Session')}>
        <Link to={sessionPath}>
          <ExternalLink className="h-3.5 w-3.5 mr-2" />
          {t('invoiceEdit.source.viewSession', 'View Session')}
        </Link>
      </Button>
    );
  } else {
    labelContent = (
      <span className="font-medium">
        {t('invoiceEdit.source.sessionCount', '{{count}} sessions', {
          count: resolved.sessionCount,
        })}
      </span>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          {t('invoiceEdit.source.title', 'Source')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-[7rem_1fr] sm:gap-x-4">
          <span className="text-muted-foreground">{typeRowLabel}</span>
          <SourceTypeBadge resolved={resolved} t={t} />
          <span className="text-muted-foreground">{labelRowLabel}</span>
          <span>{labelContent}</span>
        </div>
        {action}
      </CardContent>
    </Card>
  );
}
