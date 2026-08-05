import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { CAPPABLE_EVENTS } from '@/lib/academyNotificationCappable';
import { CapChangeDialog, type PendingCapChange } from '@/components/academy/CapChangeDialog';
import { supabase } from '@/lib/supabaseClient';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { FullPageLoader } from '@/components/ui/page-spinner';
import { QueryErrorState } from '@/components/ui/QueryErrorState';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { logger } from '@/lib/logger';
import { BellOff } from 'lucide-react';

/**
 * Academy notification controls (N3 M6) — per-academy CAPS on optional notification events.
 *
 * THE HONESTY RULES this surface must not break (design contract findings 4, 11, 12 + the
 * round-2 review's wording requirements):
 *  1. Only events with a LIVE academy-attributed v2 producer are offered
 *     (docs/NOTIFICATION_ATTRIBUTION_MATRIX.md — drift-pinned). Offering a control for a
 *     trainer-only or legacy-path event would be a switch wired to nothing.
 *  2. A cap is a CAP, never a floor: it can reduce or silence, it can never make mail send.
 *     The copy says so, and says a player's own opt-out always wins.
 *  3. "Off" stops queued not-yet-in-flight work at the NEXT worker pass — not instantly.
 *     Cadence caps (daily/weekly) govern NEWLY generated notifications only.
 *  4. Outcomes show only tenant-visible rows; player-recipient service mail is private and
 *     deliberately absent. The cap's effect on private events appears as COUNTS, never rows.
 *  5. Every change needs a reason — it is audited and shown to affected players.
 */

type CapValue = 'inherit' | 'daily' | 'weekly' | 'off';

export default function AcademyNotificationControls() {
  const { t } = useTranslation('common');
  const { activeAcademy } = useAcademyContext();
  const academyId = activeAcademy?.id ?? null;

  const [caps, setCaps] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  const [impact, setImpact] = useState<Array<Record<string, unknown>>>([]);
  const [outcomes, setOutcomes] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<PendingCapChange | null>(null);

  const load = useCallback(async () => {
    if (!academyId) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [capsRes, histRes, impactRes, outcomesRes] = await Promise.all([
        supabase.rpc('get_academy_notification_restrictions', { p_academy_profile_id: academyId }),
        supabase.rpc('get_academy_notification_restriction_audit', { p_academy_profile_id: academyId, p_limit: 20 }),
        supabase.rpc('get_academy_restriction_impact', { p_academy_profile_id: academyId, p_days: 30 }),
        supabase.rpc('get_academy_notification_outcomes', { p_academy_profile_id: academyId, p_limit: 20 }),
      ]);
      const err = capsRes.error ?? histRes.error ?? impactRes.error ?? outcomesRes.error;
      if (err) throw err;
      const map: Record<string, string> = {};
      for (const r of (capsRes.data ?? []) as unknown as Array<{ event_type: string; channel: string; max_frequency: string }>) {
        map[`${r.event_type}:${r.channel}`] = r.max_frequency;
      }
      setCaps(map);
      setHistory((histRes.data ?? []) as Array<Record<string, unknown>>);
      setImpact((impactRes.data ?? []) as Array<Record<string, unknown>>);
      setOutcomes((outcomesRes.data ?? []) as Array<Record<string, unknown>>);
    } catch (error) {
      // A failed read must never render defaults-as-state: a manager acting on a stale
      // "inherit" could double-apply or believe a cap vanished. Fail closed, offer retry.
      logger.error('Failed to load academy notification controls', undefined, { error });
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [academyId]);

  useEffect(() => {
    void load();
  }, [load]);



  const eventLabel = (key: string) => t(`notifications.events.${key}.label`, key.replace(/_/g, ' '));
  const capLabel = (v: string) => t(`academyNotifControls.cap.${v}`, v);

  const impactByKey = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of impact) {
      const k = `${r.event_type}:${r.channel}`;
      m[k] = (m[k] ?? 0) + Number(r.restricted_count ?? 0);
    }
    return m;
  }, [impact]);

  if (!academyId || loading) return <FullPageLoader />;
  if (loadFailed) {
    return (
      <AppPage width="narrow" as="main">
        <QueryErrorState onRetry={() => void load()} />
      </AppPage>
    );
  }

  return (
    <AppPage width="narrow" as="main" data-testid="academy-notification-controls">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <BellOff className="h-5 w-5" />
            {t('academyNotifControls.title', 'Notification limits for your academy')}
          </span>
        }
        description={t(
          'academyNotifControls.subtitle',
          'Reduce or stop optional notifications for people at your academy. A limit can only ever reduce: required messages are untouchable, and a player’s own choice to receive less always wins.',
        )}
      />

      <Card className={flushOnMobileCardClass()}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('academyNotifControls.capsTitle', 'Current limits')}</CardTitle>
          <CardDescription>
            {t(
              'academyNotifControls.timing',
              '“Off” stops queued mail at the next delivery pass — not instantly. Daily/weekly limits apply to newly created notifications only.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {CAPPABLE_EVENTS.map(({ event, channels }) =>
            channels.map((channel) => {
              const key = `${event}:${channel}`;
              const current = (caps[key] as CapValue | undefined) ?? 'inherit';
              return (
                <div key={key} className="flex items-center justify-between gap-3" data-testid={`cap-row-${key}`}>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{eventLabel(event)}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(`academyNotifControls.channel.${channel}`, channel)}
                      {impactByKey[key] ? (
                        <span className="ml-2">
                          {t('academyNotifControls.impactCount', {
                            defaultValue: '{{count}} stopped in the last 30 days',
                            count: impactByKey[key],
                          })}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <Select
                    value={current}
                    onValueChange={(v) => setPending({ event, channel, next: v as CapValue })}
                  >
                    <SelectTrigger className="w-36" aria-label={`${eventLabel(event)} ${channel}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">{capLabel('inherit')}</SelectItem>
                      <SelectItem value="daily">{capLabel('daily')}</SelectItem>
                      <SelectItem value="weekly">{capLabel('weekly')}</SelectItem>
                      <SelectItem value="off">{capLabel('off')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              );
            }),
          )}
          <p className="text-xs text-muted-foreground">
            {t(
              'academyNotifControls.scopeNote',
              'Only notifications your academy actually sends can be limited here. Trainer-owned mail (like open-slot alerts from a followed trainer) and platform mail are outside an academy’s reach.',
            )}
          </p>
        </CardContent>
      </Card>

      <Card className={flushOnMobileCardClass()}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('academyNotifControls.historyTitle', 'Recent changes')}</CardTitle>
          <CardDescription>
            {t('academyNotifControls.historyDesc', 'Every change is recorded and visible to affected players.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('academyNotifControls.historyEmpty', 'No changes yet.')}</p>
          ) : (
            <ul className="space-y-2">
              {history.map((h, i) => (
                <li key={i} className="text-sm" data-testid="cap-history-row">
                  <span className="font-medium">{eventLabel(String(h.event_type))}</span>{' '}
                  <span className="text-muted-foreground">
                    {String(h.old_max_frequency ?? t('academyNotifControls.cap.inherit', 'inherit'))} →{' '}
                    {String(h.new_max_frequency ?? t('academyNotifControls.cap.inherit', 'inherit'))} · {String(h.reason)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className={flushOnMobileCardClass()}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('academyNotifControls.outcomesTitle', 'Recent notification activity')}</CardTitle>
          <CardDescription>
            {t(
              'academyNotifControls.outcomesDesc',
              'Staff notifications for your academy. Players’ personal service mail is private and not shown here — limits on it appear above as counts only.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {outcomes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('academyNotifControls.outcomesEmpty', 'Nothing recent.')}</p>
          ) : (
            <ul className="space-y-2">
              {outcomes.map((o, i) => (
                <li key={i} className="flex items-center gap-2 text-sm" data-testid="outcome-row">
                  <Badge variant={o.status === 'sent' || o.status === 'delivered' ? 'secondary' : 'outline'}>
                    {String(o.status)}
                  </Badge>
                  <span className="truncate">{eventLabel(String(o.event_type))}</span>
                  <span className="truncate text-muted-foreground">{String(o.destination_redacted ?? '')}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CapChangeDialog
        pending={pending}
        academyId={academyId}
        eventLabel={eventLabel}
        onClose={() => setPending(null)}
        onSaved={load}
      />
    </AppPage>
  );
}
