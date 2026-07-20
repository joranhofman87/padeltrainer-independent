import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Bell, Mail, MessageCircle, Smartphone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  useInvoiceNotificationTimeline,
  usePlayerNotificationTimeline,
  notificationEventLabel,
  notificationEntryTimestamp,
  type NotificationTimelineEntry,
} from '@/lib/notificationTimeline';

/**
 * Compact "what did the platform send about this?" trail, backed by the PR-7a tenant-safe
 * RPCs. Everything shown is already redacted server-side — the address is `j***@x.com`, the
 * body is the sanitized public_summary; the raw destination and recipient ids never reach the
 * client. Self-hiding (renders null while loading or with no visible rows), so a surface where
 * the viewer legitimately sees nothing — e.g. staff looking at a player whose confirmations
 * are private_user_only — stays clean instead of showing an empty card.
 */
function ChannelIcon({ channel }: { channel: string }) {
  const cls = 'h-3.5 w-3.5';
  if (channel === 'whatsapp') return <MessageCircle className={cls} />;
  if (channel === 'push') return <Smartphone className={cls} />;
  return <Mail className={cls} />;
}

function StatusBadge({ entry }: { entry: NotificationTimelineEntry }) {
  const { t } = useTranslation('trainer');
  const variant =
    entry.status === 'sent' || entry.status === 'delivered'
      ? 'default'
      : entry.status === 'failed'
        ? 'destructive'
        : entry.status === 'skipped'
          ? 'outline'
          : 'secondary';
  return (
    <Badge variant={variant} className="font-normal">
      {entry.status === 'skipped' && entry.skip_reason
        ? t('notifications.timeline.skipped', 'not sent: {{reason}}', { reason: entry.skip_reason.replace(/_/g, ' ') })
        : entry.status}
    </Badge>
  );
}

export function NotificationTimelineList({ entries }: { entries: NotificationTimelineEntry[] }) {
  return (
    <ol className="space-y-3">
      {entries.map((e) => (
        <li key={e.outbox_id} className="flex items-start gap-2.5 text-sm">
          <span className="mt-0.5 text-muted-foreground">
            <ChannelIcon channel={e.channel} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{notificationEventLabel(e.event_type)}</span>
              <StatusBadge entry={e} />
            </div>
            {e.destination_redacted && (
              <p className="text-muted-foreground mt-0.5 truncate">{e.destination_redacted}</p>
            )}
          </div>
          <span
            className="shrink-0 text-xs text-muted-foreground whitespace-nowrap"
            title={format(new Date(notificationEntryTimestamp(e)), 'dd MMM yyyy HH:mm')}
          >
            {format(new Date(notificationEntryTimestamp(e)), 'dd MMM HH:mm')}
          </span>
        </li>
      ))}
    </ol>
  );
}

function TimelineCard({ entries, isLoading }: { entries: NotificationTimelineEntry[]; isLoading: boolean }) {
  const { t } = useTranslation('trainer');
  if (isLoading || entries.length === 0) return null;
  return (
    <Card data-testid="notification-timeline-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4" />
          {t('notifications.timeline.title', 'Notifications sent')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <NotificationTimelineList entries={entries} />
      </CardContent>
    </Card>
  );
}

/** Everything the platform sent about ONE invoice, within the viewer's tenant scope. */
export function InvoiceNotificationTimelineCard({ invoiceId }: { invoiceId: string }) {
  const { data: entries = [], isLoading } = useInvoiceNotificationTimeline(invoiceId);
  return <TimelineCard entries={entries} isLoading={isLoading} />;
}

/** Staff view of ONE player's notifications; empty (and hidden) while player events are private. */
export function PlayerNotificationTimelineCard(props: {
  scope: 'academy' | 'trainer';
  scopeId: string;
  guestId?: string | null;
  profileId?: string | null;
}) {
  const { data: entries = [], isLoading } = usePlayerNotificationTimeline(props);
  return <TimelineCard entries={entries} isLoading={isLoading} />;
}
