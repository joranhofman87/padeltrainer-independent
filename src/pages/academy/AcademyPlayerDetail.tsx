import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { resolveAcademyCyclusPricingRoute } from '@/lib/cyclusPricingRoute';
import { buildAcademyInvoiceEditPath } from '@/lib/academyPlayerDetailNavigation';
import { useAcademyUndeliverableRecipients } from '@/lib/emailBounce';
import { EmailBounceBadge } from '@/components/email/EmailBounceBadge';
import { EmailFixControl } from '@/components/email/EmailFixControl';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { ArrowLeft, Mail, Phone, Calendar, Cake, BarChart3, FileText, RefreshCw, Send, ExternalLink, Download, Merge } from 'lucide-react';
import { downloadInvoicePdf } from '@/lib/downloadInvoicePdf';
import { getAcademyCreateInvoiceUrl } from '@/lib/invoiceCustomer';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { useToast } from '@/hooks/use-toast';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { PlayerTag } from '@/components/players/playerTagColors';
import { TagPicker } from '@/components/players/TagPicker';
import { MergePlayersDialog } from '@/components/players/MergePlayersDialog';
import { AcademyPlayerDetailsCard } from '@/components/academy/AcademyPlayerDetailsCard';
import { PlayerLocationsControl } from '@/components/academy/PlayerLocationsControl';
import { AcademyPlayerRemoveCard } from '@/components/academy/AcademyPlayerRemoveCard';
import { getAcademyLocations } from '@/lib/academy';
import { fetchPlayerInvoices, groupSlotsIntoCycluses } from '@/lib/playerDetailData';
import { coalesceLinkedGuestIdentity, fetchLinkedProfileIdentity, type AcademyPlayerDetailsValues } from '@/lib/academyPlayerDetails';
import { buildInvoiceEmailEvents, filterInvoicesForAcademy, mapCampaignEmailEvents, mergePlayerEmailHistory, type AcademyPlayerEmailHistoryItem } from '@/lib/academyPlayerEmailHistory';
import { academyPlayersQueryKey } from '@/lib/academyPlayersQuery';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer } from 'recharts';
import { Stat, Empty, InvoiceStatus, RatingTrendCard, type RatingPoint } from '@/components/players/playerDetailParts';

interface PlayerCore {
  full_name: string;
  email: string | null;
  phone: string | null;
  skill_rating: number | null;
  rating_system: string | null;
  notes: string | null;
  source: string | null;
  birth_date: string | null;
  created_at: string;
  type: 'guest' | 'registered';
  guest_player_id: string | null;
  profile_id: string | null;
}

interface CyclusItem {
  cyclus_id: string;
  cyclus_name: string;
  first_session: string;
  last_session: string;
  session_count: number;
  href: string;
}

interface InvoiceItem {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total: number | null;
  status: string | null;
  pdf_url: string | null;
  sent_at: string | null;
  academy_profile_id: string | null;
}



export default function AcademyPlayerDetail() {
  const { t } = useTranslation('trainer');
  const { playerId } = useParams<{ playerId: string }>();
  const { activeAcademy } = useAcademyContext();
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mergeOpen, setMergeOpen] = useState(false);

  const parsed = useMemo(() => {
    if (!playerId) return { kind: null as null | 'guest' | 'profile', id: '' };
    if (playerId.startsWith('g_')) return { kind: 'guest' as const, id: playerId.slice(2) };
    if (playerId.startsWith('p_')) return { kind: 'profile' as const, id: playerId.slice(2) };
    return { kind: null, id: '' };
  }, [playerId]);

  const [loading, setLoading] = useState(true);
  const [player, setPlayer] = useState<PlayerCore | null>(null);
  const [tags, setTags] = useState<PlayerTag[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [academyLocations, setAcademyLocations] = useState<{ id: string; name: string }[]>([]);

  // Is this player's current email bouncing? (reuses the academy-wide recipients list)
  const { data: undeliverableRecipients = [] } = useAcademyUndeliverableRecipients(activeAcademy?.id);
  const isEmailBouncing = !!player && undeliverableRecipients.some(
    (r) => (player.profile_id && r.profile_id === player.profile_id) ||
           (player.guest_player_id && r.guest_player_id === player.guest_player_id),
  );
  const [detailsValues, setDetailsValues] = useState<AcademyPlayerDetailsValues | null>(null);
  const [removedAt, setRemovedAt] = useState<string | null>(null);

  const [cycluses, setCycluses] = useState<CyclusItem[]>([]);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [ratingHistory, setRatingHistory] = useState<RatingPoint[]>([]);
  const [emails, setEmails] = useState<AcademyPlayerEmailHistoryItem[]>([]);

  useEffect(() => {
    if (!parsed.kind || !parsed.id || !activeAcademy) return;
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed.kind, parsed.id, activeAcademy?.id]);

  async function loadAll() {
    setLoading(true);
    try {
      // Player core
      let core: PlayerCore | null = null;
      let guestPreferredLocationId: string | null = null;
      let registeredPreferredLocationId: string | null = null;
      const [locationsRes] = await Promise.all([
        getAcademyLocations(activeAcademy!.id),
      ]);
      const locationOptions = (locationsRes || [])
        .map((row: { location?: { id: string; name: string } }) => row.location)
        .filter((loc): loc is { id: string; name: string } => Boolean(loc?.id && loc?.name));
      setAcademyLocations(locationOptions);

      if (parsed.kind === 'guest') {
        const { data } = await supabase
          .from('guest_players')
          .select('id, full_name, email, phone, skill_rating, rating_system, notes, source, birth_date, created_at, linked_profile_id, preferred_location_id')
          .eq('id', parsed.id)
          .maybeSingle();
        if (data) {
          guestPreferredLocationId = data.preferred_location_id ?? null;
          // Linked guests: the profile is canonical for identity (same
          // precedence as the get_players_overview RPC the list view uses).
          const identity = coalesceLinkedGuestIdentity(
            {
              full_name: data.full_name,
              email: data.email,
              phone: data.phone,
              skill_rating: data.skill_rating as number | null,
              rating_system: data.rating_system,
              birth_date: data.birth_date,
            },
            data.linked_profile_id
              ? await fetchLinkedProfileIdentity(data.linked_profile_id)
              : null,
          );
          core = {
            ...identity,
            notes: data.notes,
            source: data.source,
            created_at: data.created_at,
            type: 'guest',
            guest_player_id: data.id,
            profile_id: data.linked_profile_id,
          };
        }
      } else if (parsed.kind === 'profile') {
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, email, phone, skill_rating, rating_system, birth_date, created_at')
          .eq('id', parsed.id)
          .maybeSingle();
        if (data) {
          core = {
            full_name: (data as any).full_name || '',
            email: (data as any).email,
            phone: (data as any).phone,
            skill_rating: (data as any).skill_rating ?? null,
            rating_system: (data as any).rating_system ?? null,
            notes: null,
            source: null,
            birth_date: (data as any).birth_date ?? null,
            created_at: (data as any).created_at,
            type: 'registered',
            guest_player_id: null,
            profile_id: (data as any).id,
          };
        }
      }
      setPlayer(core);
      if (!core) {
        setLoading(false);
        return;
      }

      // Tags + metadata
      const [tagsRes, metaRes] = await Promise.all([
        supabase
          .from('academy_player_tags')
          .select('*')
          .eq('academy_profile_id', activeAcademy!.id)
          .order('name'),
        (parsed.kind === 'guest'
          ? supabase
              .from('academy_player_metadata')
              .select('*')
              .eq('academy_profile_id', activeAcademy!.id)
              .eq('guest_player_id', parsed.id)
              .maybeSingle()
          : supabase
              .from('academy_player_metadata')
              .select('*')
              .eq('academy_profile_id', activeAcademy!.id)
              .eq('profile_id', parsed.id)
              .maybeSingle()),
      ]);
      setTags((tagsRes.data || []) as PlayerTag[]);
      const meta: any = metaRes.data;
      setTagIds(meta?.tag_ids || []);
      setRemovedAt(meta?.removed_at ?? null);

      registeredPreferredLocationId =
        parsed.kind === 'profile' ? (meta?.preferred_location_id as string | null) ?? null : null;

      setDetailsValues({
        name: core.full_name,
        email: core.email,
        phone: core.phone,
        locationId:
          parsed.kind === 'guest' ? guestPreferredLocationId : registeredPreferredLocationId,
        skillRating: core.skill_rating,
        ratingSystem: core.rating_system || 'knltb',
        notes:
          parsed.kind === 'guest'
            ? core.notes
            : meta?.notes ?? null,
      });

      // Bookings (cycluses)
      const bookingFilter = parsed.kind === 'guest'
        ? supabase.from('bookings').select('id, slot_id, status').eq('guest_player_id', parsed.id)
        : supabase.from('bookings').select('id, slot_id, status').eq('player_id', parsed.id);
      const { data: bookingsData } = await bookingFilter;
      const slotIds = Array.from(new Set((bookingsData || []).map((b: any) => b.slot_id))).filter(Boolean);

      let cycluses: CyclusItem[] = [];
      if (slotIds.length) {
        const { data: slots } = await supabase
          .from('availability_slots')
          .select('id, cyclus_id, cyclus_name, start_time')
          .in('id', slotIds);
        const slotsArr = (slots || []) as any[];

        // Cycluses
        const rawCycluses = groupSlotsIntoCycluses(
          slotsArr,
          t('players.detail.singleSessions', 'Single sessions'),
        );

        cycluses = await Promise.all(
          rawCycluses.map(async (c) => ({
            ...c,
            href: await resolveAcademyCyclusPricingRoute(c.cyclus_id),
          })),
        );
      }
      setCycluses(cycluses);

      // Invoices (scoped to current academy)
      const invoiceRows = (await fetchPlayerInvoices(
        { kind: 'academy', id: activeAcademy!.id },
        { kind: parsed.kind, id: parsed.id },
      )) as unknown as InvoiceItem[];
      setInvoices(invoiceRows);

      // Rating history (only for registered profiles)
      if (parsed.kind === 'profile') {
        const { data: ratings } = await supabase
          .from('player_rating_history')
          .select('rating, rating_system, source, scraped_at, created_at')
          .eq('profile_id', parsed.id)
          .order('scraped_at', { ascending: true });
        setRatingHistory(
          (ratings || []).map((r: any) => ({
            date: r.scraped_at || r.created_at,
            rating: Number(r.rating),
            source: r.source || r.rating_system,
          }))
        );
      } else {
        setRatingHistory([]);
      }

      // Email history: campaign emails + invoice send events
      const emailAddr = core.email;
      let campaignEmails: AcademyPlayerEmailHistoryItem[] = [];
      if (emailAddr) {
        const { data: recs } = await supabase
          .from('email_campaign_recipients')
          .select('id, status, sent_at, created_at, campaign_id, email_campaigns!inner(subject, status, academy_profile_id)')
          .eq('recipient_email', emailAddr)
          .eq('email_campaigns.academy_profile_id', activeAcademy!.id)
          .order('created_at', { ascending: false });
        campaignEmails = mapCampaignEmailEvents(
          (recs || []).map((r: any) => ({
            id: r.id,
            subject: r.email_campaigns?.subject || '—',
            status: r.status,
            sent_at: r.sent_at,
            created_at: r.created_at,
          })),
        );
      }

      const invoiceEmailEvents = buildInvoiceEmailEvents(
        filterInvoicesForAcademy(invoiceRows, activeAcademy!.id),
        {
          sent: t('players.detail.invoiceSent', 'Invoice sent'),
          sentWithNumber: (number) =>
            t('players.detail.invoiceSentNumber', 'Invoice #{{number}}', { number }),
        },
      );
      setEmails(mergePlayerEmailHistory(campaignEmails, invoiceEmailEvents));
    } catch (err: any) {
      logger.error('Error loading player detail', err);
      toast({ title: t('common:error', 'Error'), description: getFriendlyErrorMessage(err, t('players.detail.loadError', 'Could not load player details. Please try again.')), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  function handleDetailsSaved(next: AcademyPlayerDetailsValues) {
    queryClient.invalidateQueries({ queryKey: academyPlayersQueryKey(activeAcademy?.id) });
    setDetailsValues(next);
    setPlayer((prev) =>
      prev
        ? {
            ...prev,
            full_name: next.name,
            email: next.email,
            phone: next.phone,
            skill_rating: next.skillRating,
            rating_system: next.ratingSystem,
            notes: next.notes,
          }
        : prev,
    );
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!player) {
    return (
      <div className="p-6">
        <Link to="/app/academy/players" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="h-4 w-4 mr-1" /> {t('players.detail.back', 'Back to players')}
        </Link>
        <p className="mt-4 text-muted-foreground">{t('players.detail.notFound', 'Player not found')}</p>
      </div>
    );
  }

  const initials = player.full_name
    .split(' ')
    .map(n => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <Link
        to="/app/academy/players"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> {t('players.detail.back', 'Back to players')}
      </Link>

      {/* Header */}
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
              {player.skill_rating != null && (
                <Badge variant="secondary">
                  {player.skill_rating.toFixed(1)} {(player.rating_system || 'knltb').toUpperCase()}
                </Badge>
              )}
              {(() => {
                const todayIso = new Date().toISOString().slice(0, 10);
                const overdueCount = invoices.filter((inv) => {
                  const status = (inv.status || '').toLowerCase();
                  if (status === 'overdue') return true;
                  if (status === 'paid' || status === 'cancelled' || status === 'draft' || status === 'void') return false;
                  return !!inv.due_date && inv.due_date < todayIso;
                }).length;
                if (!overdueCount) return null;
                return (
                  <Badge variant="destructive">
                    {t('players.detail.overdueBadge', 'Overdue payment')}
                    {overdueCount > 1 ? ` (${overdueCount})` : ''}
                  </Badge>
                );
              })()}
              {isEmailBouncing && <EmailBounceBadge />}
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
              {player.birth_date && (
                <span className="inline-flex items-center gap-1.5">
                  <Cake className="h-3.5 w-3.5" /> {format(new Date(player.birth_date), 'dd-MM-yyyy')}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                {t('players.detail.addedOn', 'Added')} {format(new Date(player.created_at), 'dd-MM-yyyy')}
              </span>
            </div>
            {activeAcademy && player && (
              <div className="pt-2">
                <PlayerLocationsControl
                  academyProfileId={activeAcademy.id}
                  profileId={player.profile_id}
                  guestPlayerId={player.guest_player_id}
                  academyLocations={academyLocations}
                />
              </div>
            )}
            {isEmailBouncing && activeAcademy && player && (
              <div className="pt-2 max-w-md">
                <EmailFixControl
                  academyProfileId={activeAcademy.id}
                  playerType={player.type}
                  profileId={player.profile_id}
                  guestPlayerId={player.guest_player_id}
                  currentEmail={player.email}
                />
              </div>
            )}
            {activeAcademy && player && (
              <div className="pt-2">
                <TagPicker
                  academyId={activeAcademy.id}
                  playerKey={{
                    guest_player_id: player.guest_player_id,
                    profile_id: player.profile_id,
                  }}
                  tags={tags}
                  selectedTagIds={tagIds}
                  onTagsChange={setTags}
                  onSelectedTagIdsChange={setTagIds}
                  onChanged={() =>
                    invalidateAllPlayerData(queryClient, { kind: 'academy', id: activeAcademy.id })
                  }
                  variant="detail"
                />
              </div>
            )}
          </div>
          {playerId && (
            <div className="shrink-0 md:self-start flex flex-col items-stretch gap-2">
              <Button asChild data-testid="academy-player-create-invoice" aria-label={t('players.detail.createInvoice', 'Create invoice')}>
                <Link to={getAcademyCreateInvoiceUrl(playerId)}>
                  <FileText className="h-4 w-4 mr-2" />
                  {t('players.detail.createInvoice', 'Create invoice')}
                </Link>
              </Button>
              {player.type === 'guest' && player.guest_player_id && (
                <Button
                  variant="outline"
                  data-testid="academy-player-merge-button"
                  onClick={() => setMergeOpen(true)}
                >
                  <Merge className="h-4 w-4 mr-2" />
                  {t('players.merge.action', 'Merge with another player…')}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Always visible rating progress trend */}
      <RatingTrendCard
        history={ratingHistory}
        ratingSystem={player.rating_system}
        currentRating={player.skill_rating}
        isGuest={player.type === 'guest'}
        t={t}
      />

      {/* Summary */}
      <Card className={flushOnMobileCardClass()} data-testid="academy-player-summary">
        <CardHeader>
          <CardTitle className="text-base">{t('players.detail.summary', 'Summary')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <Stat label={t('players.detail.stats.cycles', 'Cycles')} value={cycluses.length} />
          <Stat label={t('players.detail.stats.invoices', 'Invoices')} value={invoices.length} />
          <Stat label={t('players.detail.stats.ratingPoints', 'Rating points')} value={ratingHistory.length} />
          <Stat label={t('players.detail.stats.emails', 'Emails')} value={emails.length} />
        </CardContent>
      </Card>

      {/* Player details */}
      {detailsValues && activeAcademy && (
        <AcademyPlayerDetailsCard
          kind={player.type}
          academyProfileId={activeAcademy.id}
          guestPlayerId={player.guest_player_id}
          profileId={player.profile_id}
          values={detailsValues}
          locations={academyLocations}
          tagIds={tagIds}
          onSaved={handleDetailsSaved}
        />
      )}

      {/* Cycles */}
      <Card className={flushOnMobileCardClass()} data-testid="academy-player-section-cycles">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            {t('players.detail.sectionCycles', 'Cycles')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 divide-y">
          {cycluses.length === 0 ? (
            <Empty icon={<RefreshCw className="h-8 w-8" />} text={t('players.detail.noCycles', 'No cycles joined yet')} />
          ) : (
            cycluses.map(c => (
              <Link
                key={c.cyclus_id}
                to={c.href}
                data-testid={`academy-player-cycle-link-${c.cyclus_id}`}
                className="flex items-center justify-between gap-4 p-4 transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0">
                  <p className="font-medium">{c.cyclus_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.first_session && format(new Date(c.first_session), 'dd-MM-yyyy')}
                    {' → '}
                    {c.last_session && format(new Date(c.last_session), 'dd-MM-yyyy')}
                    {' · '}
                    {c.session_count} {t('players.detail.sessions', 'sessions')}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                  {t('players.detail.openRecord', 'Open')}
                  <ExternalLink className="h-3.5 w-3.5" />
                </span>
              </Link>
            ))
          )}
        </CardContent>
      </Card>

      {/* Invoices */}
      <Card className={flushOnMobileCardClass()} data-testid="academy-player-section-invoices">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {t('players.detail.sectionInvoices', 'Invoices')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 divide-y">
          {invoices.length === 0 ? (
            <Empty icon={<FileText className="h-8 w-8" />} text={t('players.detail.noInvoices', 'No invoices yet')} />
          ) : (
            invoices.map(inv => (
              <div
                key={inv.id}
                className="flex items-center gap-3 p-4 transition-colors hover:bg-muted/50"
              >
                <Link
                  to={buildAcademyInvoiceEditPath(inv.id)}
                  data-testid={`academy-player-invoice-link-${inv.id}`}
                  className="flex flex-1 min-w-0 items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{inv.invoice_number || `#${inv.id.slice(0, 8)}`}</p>
                    <p className="text-xs text-muted-foreground">
                      {inv.invoice_date && format(new Date(inv.invoice_date), 'dd-MM-yyyy')}
                      {inv.total != null && ` · €${Number(inv.total).toFixed(2)}`}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                    {t('players.detail.openRecord', 'Open')}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </span>
                </Link>
                <div className="flex items-center gap-2 shrink-0">
                  <InvoiceStatus status={inv.status} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const ok = await downloadInvoicePdf(inv.id, inv.invoice_number || undefined);
                      if (!ok) {
                        toast({
                          title: t('players.detail.downloadFailed', 'Download failed'),
                          variant: 'destructive',
                        });
                      }
                    }}
                    title={t('players.detail.downloadInvoice', 'Download invoice')}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Rating history */}
      <Card className={flushOnMobileCardClass()} data-testid="academy-player-section-rating">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            {t('players.detail.ratingHistory', 'Rating history')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {ratingHistory.length === 0 ? (
            <Empty icon={<BarChart3 className="h-8 w-8" />} text={t('players.detail.noRating', 'No rating history available')} />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={ratingHistory.map(r => ({
                  ...r,
                  label: format(new Date(r.date), 'MMM yyyy'),
                }))}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} reversed />
                  <RTooltip />
                  <Line type="monotone" dataKey="rating" stroke="hsl(var(--primary))" strokeWidth={2} dot />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Email history */}
      <Card className={flushOnMobileCardClass()} data-testid="academy-player-section-emails">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="h-4 w-4" />
            {t('players.detail.emailHistory', 'Email history')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 divide-y">
          {emails.length === 0 ? (
            <Empty icon={<Send className="h-8 w-8" />} text={t('players.detail.noEmails', 'No emails sent yet')} />
          ) : (
            emails.map((e) => {
              const timestamp = e.sent_at
                ? format(new Date(e.sent_at), 'dd-MM-yyyy HH:mm')
                : format(new Date(e.created_at), 'dd-MM-yyyy HH:mm');
              const title = e.href ? (
                <Link
                  to={e.href}
                  className="font-medium truncate hover:underline"
                  data-testid={`academy-player-email-link-${e.id}`}
                >
                  {e.title}
                </Link>
              ) : (
                <p className="font-medium truncate">{e.title}</p>
              );

              return (
                <div
                  key={e.id}
                  className="p-4 flex items-center justify-between gap-4"
                  data-testid={`academy-player-email-${e.id}`}
                >
                  <div className="min-w-0">
                    {title}
                    <p className="text-xs text-muted-foreground">
                      {e.subtitle ? `${e.subtitle} · ${timestamp}` : timestamp}
                    </p>
                  </div>
                  <Badge
                    variant={
                      e.status === 'sent'
                        ? 'default'
                        : e.status === 'failed'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {e.status}
                  </Badge>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {activeAcademy && player && parsed.kind && (
        <AcademyPlayerRemoveCard
          kind={parsed.kind === 'guest' ? 'guest' : 'registered'}
          academyProfileId={activeAcademy.id}
          guestPlayerId={player.guest_player_id}
          profileId={player.profile_id}
          playerName={player.full_name}
          removedAt={removedAt}
        />
      )}

      {activeAcademy && player.guest_player_id && (
        <MergePlayersDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          scope={{ kind: 'academy', id: activeAcademy.id }}
          currentPlayer={{ guestPlayerId: player.guest_player_id, full_name: player.full_name }}
          onMerged={(targetGuestId) => {
            if (targetGuestId === player.guest_player_id) {
              // Current player survived as the target — refresh in place.
              void loadAll();
            } else {
              // Current player was the deleted source — go to the survivor.
              navigate(`/app/academy/players/g_${targetGuestId}`);
            }
          }}
        />
      )}
    </div>
  );
}
