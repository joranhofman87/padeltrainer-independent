import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { FullPageLoader } from '@/components/ui/page-spinner';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { ArrowLeft, Bell, Lock } from 'lucide-react';
import { logger } from '@/lib/logger';

/**
 * Notification settings — v2 (Notification Foundation, PR 8).
 *
 * Driven by the notification_event_types CATALOG (readable by `authenticated` precisely so
 * this page can label itself) and stored per user × event in notification_preferences_v2.
 *
 * Three rules this page must not break:
 *  1. REQUIRED-DELIVERY events render as "Always on" with NO control. The resolver forces
 *     email_frequency := 'instant' for them regardless of what is stored, so offering a
 *     switch would be a control that silently does nothing.
 *  2. A MISSING pref row means "use the event's default", not "off" — so we only write on
 *     change and never pre-seed rows.
 *  3. WhatsApp/push are NOT shown. No seeded event supports push, and whatsapp cannot deliver
 *     until PR 9 provisions Twilio; an opt-in for a channel that cannot deliver is a promise
 *     we do not keep.
 *
 * Role filtering treats academy_manager + trainer as ONE "staff" bucket rather than trusting
 * `audience` literally: booking_confirmed_staff is catalogued 'academy_manager' but PR 6b's
 * fan-out also sends it to TRAINERS, so a literal match would hide a setting from people who
 * actually receive that mail.
 *
 * "Other notifications" is a deliberate TRANSITIONAL bridge exposing the COMPLETE v1 column
 * set. The rule is "every column send-email can still consult", NOT "columns with no v2 event
 * key" — the latter is too narrow and strands live settings, because send-email still gates
 * legacy sends on booking_confirmation / booking_reminder / booking_cancelled / new_review /
 * payment_receipt / payment_received / new_booking / open_slots_digest even where a v2 event of
 * a similar NAME exists (they are two different enforcement paths). Dropping any of them would
 * leave a live setting enforced but unreachable. PR 10 migrates those senders and the group goes.
 *
 * NOTE: this route is deep-linked from outbound email footers as the unsubscribe target, and
 * academy-managed trainers are deliberately exempted from the usual route bounce to reach it
 * (TrainerLayout). Keep both behaviours.
 */

type Frequency = 'instant' | 'daily' | 'weekly' | 'off';
const FREQUENCIES: Frequency[] = ['instant', 'daily', 'weekly', 'off'];
const DIGEST_ONLY: Frequency[] = ['daily', 'weekly', 'off'];

interface EventType {
  key: string;
  category: string;
  audience: string;
  required_delivery: boolean;
  supports_email: boolean;
  supports_digest: boolean;
  default_email_frequency: Frequency;
}

/**
 * EVERY v1 preference column, kept reachable until PR 10 migrates the legacy senders.
 *
 * The rule here is NOT "columns with no v2 event key" — that was too narrow and stranded live
 * settings. It is "every column send-email can still consult". send-email's TYPE_TO_PREF_COLUMN
 * maps its types onto booking_confirmation / booking_reminder / booking_cancelled / new_review /
 * payment_receipt / payment_received / new_booking / open_slots_digest, and those paths are still
 * live (send-digest-emails sends booking_confirmation|booking_reminder|booking_cancelled;
 * BookLesson sends booking_request → new_booking; BookForPlayerDialog sends
 * manual_booking_confirmation → booking_confirmation; notify-followers sends
 * new_availability|slot_reopened → open_slots_digest). The remaining columns have no v2 key at
 * all. Union = the complete v1 set, so nothing a user could previously control becomes
 * unreachable just because the v2 page shipped.
 */
const LEGACY_PLAYER = [
  'booking_confirmation', 'booking_reminder', 'open_slots_digest',
  'upcoming_sessions_digest', 'payment_receipt', 'waitlist_update',
] as const;
const LEGACY_STAFF = [
  'new_booking', 'booking_cancelled', 'new_follower', 'new_player',
  'new_registration', 'new_review', 'upcoming_schedule_digest', 'payment_received',
] as const;
const LEGACY_DIGEST = new Set<string>(['open_slots_digest', 'upcoming_sessions_digest', 'upcoming_schedule_digest']);
/** Mirrors the COLUMN DEFAULTs in migration 20260210090026 exactly — do not guess these. */
const LEGACY_DEFAULTS: Record<string, Frequency> = {
  booking_confirmation: 'instant', booking_reminder: 'instant', open_slots_digest: 'weekly',
  upcoming_sessions_digest: 'daily', payment_receipt: 'instant', waitlist_update: 'instant',
  new_booking: 'instant', booking_cancelled: 'instant', new_follower: 'daily', new_player: 'daily',
  new_registration: 'instant', new_review: 'instant', upcoming_schedule_digest: 'daily',
  payment_received: 'instant',
};
type LegacyKey = (typeof LEGACY_PLAYER)[number] | (typeof LEGACY_STAFF)[number];

const STAFF_AUDIENCES = new Set(['academy_manager', 'trainer']);

export default function NotificationSettings() {
  const { user, role, isAcademyManager, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation('common');

  const [catalog, setCatalog] = useState<EventType[]>([]);
  const [prefs, setPrefs] = useState<Record<string, Frequency>>({});
  const [legacy, setLegacy] = useState<Record<string, Frequency>>({});
  const [dataLoading, setDataLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // academy_manager + trainer are ONE staff bucket (see header note).
  const isStaff = Boolean(isAcademyManager) || role === 'trainer';

  useEffect(() => {
    if (!loading && !user) navigate('/app/auth');
  }, [user, loading, navigate]);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [types, rows, v1] = await Promise.all([
        supabase
          .from('notification_event_types')
          .select('key, category, audience, required_delivery, supports_email, supports_digest, default_email_frequency'),
        supabase.from('notification_preferences_v2').select('event_type, email_frequency').eq('user_id', user.id),
        supabase.from('notification_preferences').select('*').eq('user_id', user.id).maybeSingle(),
      ]);

      setCatalog(((types.data ?? []) as unknown as EventType[]).filter((e) => e.supports_email));

      const map: Record<string, Frequency> = {};
      for (const r of (rows.data ?? []) as Array<{ event_type: string; email_frequency: Frequency }>) {
        map[r.event_type] = r.email_frequency;
      }
      setPrefs(map);

      const legacyRow = (v1.data ?? {}) as Record<string, string | null>;
      const legacyMap: Record<string, Frequency> = {};
      for (const k of [...LEGACY_PLAYER, ...LEGACY_STAFF]) {
        legacyMap[k] = (legacyRow[k] as Frequency | null) ?? LEGACY_DEFAULTS[k];
      }
      setLegacy(legacyMap);
    } catch (error) {
      logger.error('Failed to load notification settings', undefined, { error });
    } finally {
      setDataLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  const failToast = (error: unknown) =>
    toast({
      title: t('notifications.saveError'),
      description: getFriendlyErrorMessage(error, t('notifications.saveErrorDescription', 'Please try again.')),
      variant: 'destructive',
    });

  /** PESSIMISTIC: reflect the new value only AFTER the write succeeds, so a failed save never
   *  leaves the UI showing something the database does not have (v1 did the reverse). */
  const saveEvent = async (eventKey: string, frequency: Frequency) => {
    if (!user) return;
    setSavingKey(eventKey);
    try {
      const { error } = await supabase
        .from('notification_preferences_v2')
        .upsert(
          { user_id: user.id, event_type: eventKey, email_frequency: frequency, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,event_type' },
        );
      if (error) throw error;
      setPrefs((p) => ({ ...p, [eventKey]: frequency }));
      toast({ title: t('notifications.saved') });
    } catch (error) {
      logger.error('Failed to save notification preference', undefined, { error, eventKey });
      failToast(error);
    } finally {
      setSavingKey(null);
    }
  };

  /**
   * Legacy v1 column write. UPSERT on user_id — notification_preferences.user_id is UNIQUE, so
   * unlike v1's select-then-insert/update this is atomic. With per-row saving, two quick changes
   * by a brand-new user would otherwise BOTH observe "no row" and BOTH insert, and the second
   * would die on the unique constraint (losing that change). Unset columns keep their COLUMN
   * DEFAULTs on insert and are left untouched on conflict.
   */
  const saveLegacy = async (column: LegacyKey, frequency: Frequency) => {
    if (!user) return;
    setSavingKey(column);
    try {
      const { error } = await supabase
        .from('notification_preferences')
        .upsert(
          { user_id: user.id, [column]: frequency, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        );
      if (error) throw error;
      setLegacy((l) => ({ ...l, [column]: frequency }));
      toast({ title: t('notifications.saved') });
    } catch (error) {
      logger.error('Failed to save legacy notification preference', undefined, { error, column });
      failToast(error);
    } finally {
      setSavingKey(null);
    }
  };

  if (loading || dataLoading) return <FullPageLoader />;

  const visible = catalog.filter((e) => (STAFF_AUDIENCES.has(e.audience) ? isStaff : true));
  const alwaysOn = visible.filter((e) => e.required_delivery);
  const configurable = visible.filter((e) => !e.required_delivery);
  const legacyKeys: LegacyKey[] = [...LEGACY_PLAYER, ...(isStaff ? LEGACY_STAFF : [])];

  const eventLabel = (key: string) => t(`notifications.events.${key}.label`, key.replace(/_/g, ' '));
  const freqLabel = (f: Frequency) => t(`notifications.frequency.${f}`);

  return (
    <main className="container mx-auto max-w-3xl px-4 py-6 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label={t('back')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Bell className="h-5 w-5" />
            {t('notifications.heading')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('notifications.subtitle')}</p>
        </div>
      </div>

      {configurable.length > 0 && (
        <Card data-testid="notification-settings-configurable">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('notifications.sections.choose', 'Your notifications')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {configurable.map((e) => (
              <div key={e.key} className="flex items-center justify-between gap-4" data-testid={`pref-row-${e.key}`}>
                <Label htmlFor={`pref-${e.key}`} className="font-normal">{eventLabel(e.key)}</Label>
                {e.supports_digest ? (
                  <Select
                    value={prefs[e.key] ?? e.default_email_frequency}
                    onValueChange={(v) => saveEvent(e.key, v as Frequency)}
                    disabled={savingKey === e.key}
                  >
                    <SelectTrigger id={`pref-${e.key}`} className="w-[130px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{freqLabel(f)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Switch
                    id={`pref-${e.key}`}
                    checked={(prefs[e.key] ?? e.default_email_frequency) !== 'off'}
                    onCheckedChange={(on) => saveEvent(e.key, on ? 'instant' : 'off')}
                    disabled={savingKey === e.key}
                  />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {legacyKeys.length > 0 && (
        <Card data-testid="notification-settings-legacy">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('notifications.sections.other', 'Other notifications')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {legacyKeys.map((k) => (
              <div key={k} className="flex items-center justify-between gap-4" data-testid={`pref-row-${k}`}>
                <Label htmlFor={`pref-${k}`} className="font-normal">{t(`notifications.types.${k}.label`)}</Label>
                <Select
                  value={legacy[k] ?? LEGACY_DEFAULTS[k]}
                  onValueChange={(v) => saveLegacy(k, v as Frequency)}
                  disabled={savingKey === k}
                >
                  <SelectTrigger id={`pref-${k}`} className="w-[130px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(LEGACY_DIGEST.has(k) ? DIGEST_ONLY : FREQUENCIES).map((f) => (
                      <SelectItem key={f} value={f}>{freqLabel(f)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {alwaysOn.length > 0 && (
        <Card data-testid="notification-settings-always-on">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="h-4 w-4" />
              {t('notifications.sections.alwaysOn', 'Always sent')}
            </CardTitle>
            <CardDescription>
              {t('notifications.sections.alwaysOnDesc', 'Receipts, confirmations and security emails cannot be turned off.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {alwaysOn.map((e) => (
              <div key={e.key} className="flex items-center justify-between gap-4 text-sm" data-testid={`always-on-${e.key}`}>
                <span>{eventLabel(e.key)}</span>
                <Badge variant="secondary" className="font-normal">{t('notifications.alwaysOn', 'Always on')}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
