import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { ArrowLeft, Mail, Phone, MapPin, Calendar, Cake, BarChart3, FileText, RefreshCw, Send, ExternalLink, Download, Merge } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useTrainerCanEdit } from '@/hooks/useTrainerHasAcademy';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { getTrainerCreateInvoiceUrl } from '@/lib/invoiceCustomer';
import { isTrainerRegisteredPlayerVisible } from '@/lib/invoiceSelectablePlayers';
import { buildTrainerInvoiceEditPath } from '@/lib/trainerPlayerDetailNavigation';
import { resolveTrainerCyclusPricingRoute } from '@/lib/trainerCyclusPricingRoute';
import { downloadInvoicePdf } from '@/lib/downloadInvoicePdf';
import { coalesceLinkedGuestIdentity, fetchLinkedProfileIdentity } from '@/lib/academyPlayerDetails';
import { fetchTrainerLocationOptions, type TrainerPlayerDetailsValues } from '@/lib/trainerPlayerDetails';
import { fetchPersonRefSet, fetchPersonBookingSlotIds, fetchPersonInvoices, groupSlotsIntoCycluses } from '@/lib/playerDetailData';
import { fetchTrainerPlayerTrainingLocations } from '@/lib/trainerPlayerTrainingLocations';
import { trainerPlayersQueryKey } from '@/lib/trainerPlayersQuery';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { buildTrainerInvoiceEmailEvents, filterInvoicesForTrainer, mapCampaignEmailEvents, mergePlayerEmailHistory, type TrainerPlayerEmailHistoryItem } from '@/lib/trainerPlayerEmailHistory';
import { TrainerPlayerDetailsCard } from '@/components/trainer/TrainerPlayerDetailsCard';
import { PlayerNotificationTimelineCard } from '@/components/notifications/NotificationTimelineCard';
import { TrainerPlayerRemoveCard } from '@/components/trainer/TrainerPlayerRemoveCard';
import { MergePlayersDialog } from '@/components/players/MergePlayersDialog';
import { PLAYER_MERGE_UNAVAILABLE_I18N } from '@/lib/playerMergeAvailability';
import { TagPicker } from '@/components/players/TagPicker';
import { PlayerTag } from '@/components/players/playerTagColors';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getTagColorClass } from '@/components/players/playerTagColors';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
  trainer_id: string | null;
}


export default function TrainerPlayerDetail() {
  const { t } = useTranslation('trainer');
  const { playerId } = useParams<{ playerId: string }>();
  const { user } = useAuth();
  const { canEdit } = useTrainerCanEdit();
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

  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [player, setPlayer] = useState<PlayerCore | null>(null);
  // Phase 3.3d: person-level login (from get_person_refs_for_scope) drives the type badge so a
  // merged account holder clicked via their guest side reads 'Registered'. undefined → seat fallback.
  const [personHasLogin, setPersonHasLogin] = useState<boolean | undefined>(undefined);
  const [tags, setTags] = useState<PlayerTag[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [locationNames, setLocationNames] = useState<string[]>([]);
  const [trainerLocations, setTrainerLocations] = useState<{ id: string; name: string }[]>([]);
  const [detailsValues, setDetailsValues] = useState<TrainerPlayerDetailsValues | null>(null);
  const [removedAt, setRemovedAt] = useState<string | null>(null);

  const [cycluses, setCycluses] = useState<CyclusItem[]>([]);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [ratingHistory, setRatingHistory] = useState<RatingPoint[]>([]);
  const [emails, setEmails] = useState<TrainerPlayerEmailHistoryItem[]>([]);

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
      let guestPreferredLocationId: string | null = null;
      let registeredPreferredLocationId: string | null = null;

      const locationOptions = await fetchTrainerLocationOptions(trainerId!);
      setTrainerLocations(locationOptions);

      if (parsed.kind === 'guest') {
        const { data } = await supabase
          .from('guest_players')
          .select(
            'id, full_name, email, phone, skill_rating, rating_system, notes, source, birth_date, created_at, linked_profile_id, preferred_location_id, trainer_id',
          )
          .eq('id', parsed.id)
          .maybeSingle();
        if (data && data.trainer_id === trainerId) {
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
        const visible = await isTrainerRegisteredPlayerVisible(trainerId!, parsed.id);
        if (visible) {
          const { data } = await supabase
            .from('profiles')
            .select('id, full_name, email, phone, skill_rating, rating_system, birth_date, created_at')
            .eq('id', parsed.id)
            .maybeSingle();
          if (data) {
            core = {
              full_name: (data as { full_name?: string }).full_name || '',
              email: (data as { email?: string | null }).email ?? null,
              phone: (data as { phone?: string | null }).phone ?? null,
              skill_rating: (data as { skill_rating?: number | null }).skill_rating ?? null,
              rating_system: (data as { rating_system?: string | null }).rating_system ?? null,
              notes: null,
              source: null,
              birth_date: (data as { birth_date?: string | null }).birth_date ?? null,
              created_at: (data as { created_at: string }).created_at,
              type: 'registered',
              guest_player_id: null,
              profile_id: (data as { id: string }).id,
            };
          }
        }
      }

      setPlayer(core);
      if (!core) {
        setLoading(false);
        return;
      }

      const [tagsRes, metaRes] = await Promise.all([
        supabase
          .from('academy_player_tags')
          .select('*')
          .eq('trainer_profile_id', trainerId!)
          .order('name'),
        parsed.kind === 'guest'
          ? supabase
              .from('academy_player_metadata')
              .select('*')
              .eq('trainer_profile_id', trainerId!)
              .eq('guest_player_id', parsed.id)
              .maybeSingle()
          : supabase
              .from('academy_player_metadata')
              .select('*')
              .eq('trainer_profile_id', trainerId!)
              .eq('profile_id', parsed.id)
              .maybeSingle(),
      ]);
      setTags((tagsRes.data || []) as PlayerTag[]);
      const meta = metaRes.data as {
        tag_ids?: string[];
        notes?: string | null;
        preferred_location_id?: string | null;
        removed_at?: string | null;
      } | null;
      setTagIds(meta?.tag_ids || []);
      setRemovedAt(meta?.removed_at ?? null);

      registeredPreferredLocationId =
        parsed.kind === 'profile' ? meta?.preferred_location_id ?? null : null;

      setDetailsValues({
        name: core.full_name,
        email: core.email,
        phone: core.phone,
        locationId:
          parsed.kind === 'guest' ? guestPreferredLocationId : registeredPreferredLocationId,
        skillRating: core.skill_rating,
        ratingSystem: core.rating_system || 'knltb',
        notes: parsed.kind === 'guest' ? core.notes : meta?.notes ?? null,
      });

      const trainingLocations = await fetchTrainerPlayerTrainingLocations({
        trainerProfileId: trainerId!,
        guestPlayerId: parsed.kind === 'guest' ? parsed.id : null,
        profileId: parsed.kind === 'profile' ? parsed.id : null,
      });
      setLocationNames(trainingLocations.map((l) => l.location_name));

      // Person-complete bookings (Phase 3.3b): union a merged human's seats across BOTH old keys.
      // Bookings RLS already scopes to this trainer's slots, and the availability_slots read below
      // re-applies .eq('trainer_id') — so a person's sessions under OTHER trainers never leak in.
      const personRefs = await fetchPersonRefSet(
        { kind: 'trainer', id: trainerId! },
        { kind: parsed.kind, id: parsed.id },
      );
      setPersonHasLogin(personRefs.hasLogin); // Phase 3.3d: person-level login for the type badge
      const slotIds = await fetchPersonBookingSlotIds(personRefs);

      let cyclusItems: CyclusItem[] = [];
      if (slotIds.length) {
        const { data: slots } = await supabase
          .from('availability_slots')
          .select('id, cyclus_id, cyclus_name, start_time')
          .in('id', slotIds)
          .eq('trainer_id', trainerId!);
        const slotsArr = (slots || []) as Array<{
          id: string;
          cyclus_id: string | null;
          cyclus_name: string | null;
          start_time: string | null;
        }>;

        const rawCycluses = groupSlotsIntoCycluses(
          slotsArr,
          t('players.detail.singleSessions', 'Single sessions'),
        );

        cyclusItems = await Promise.all(
          rawCycluses.map(async (c) => ({
            ...c,
            href: await resolveTrainerCyclusPricingRoute(c.cyclus_id),
          })),
        );
      }
      setCycluses(cyclusItems);

      const invoiceRows = (await fetchPersonInvoices(
        { kind: 'trainer', id: trainerId! },
        personRefs,
      )) as unknown as InvoiceItem[];
      setInvoices(invoiceRows);

      // Phase 3.6: rating history keys on the PROFILE — use the tenant-authorized
      // person-resolved ref when the page was opened via a guest ref, so g_ URLs
      // query the same profile the p_ route would. NOTE: player_rating_history
      // RLS is still self-view + admin only (deliberately deferred, see
      // 20260829100000), so non-admin viewers get an empty trend on BOTH routes
      // until a tenant read path ships; this keeps the g_ route congruent.
      const ratingProfileId = parsed.kind === 'profile' ? parsed.id : (personRefs.profileId ?? null);
      if (ratingProfileId) {
        const { data: ratings } = await supabase
          .from('player_rating_history')
          .select('rating, rating_system, source, scraped_at, created_at')
          .eq('profile_id', ratingProfileId)
          .order('scraped_at', { ascending: true });
        setRatingHistory(
          (ratings || []).map((r) => ({
            date: (r as { scraped_at?: string; created_at: string }).scraped_at ||
              (r as { created_at: string }).created_at,
            rating: Number((r as { rating: number }).rating),
            source: (r as { source?: string; rating_system?: string }).source ||
              (r as { rating_system?: string }).rating_system ||
              'knltb',
          })),
        );
      } else {
        setRatingHistory([]);
      }

      const emailAddr = core.email;
      let campaignEmails: TrainerPlayerEmailHistoryItem[] = [];
      if (emailAddr) {
        const { data: recs } = await supabase
          .from('email_campaign_recipients')
          .select(
            'id, status, sent_at, created_at, campaign_id, email_campaigns!inner(subject, status, trainer_profile_id)',
          )
          .eq('recipient_email', emailAddr)
          .eq('email_campaigns.trainer_profile_id', trainerId!)
          .order('created_at', { ascending: false });
        campaignEmails = mapCampaignEmailEvents(
          (recs || []).map((r) => {
            const row = r as {
              id: string;
              status: string;
              sent_at: string | null;
              created_at: string;
              email_campaigns?: { subject?: string };
            };
            return {
              id: row.id,
              subject: row.email_campaigns?.subject || '—',
              status: row.status,
              sent_at: row.sent_at,
              created_at: row.created_at,
            };
          }),
        );
      }

      const invoiceEmailEvents = buildTrainerInvoiceEmailEvents(
        filterInvoicesForTrainer(invoiceRows, trainerId!),
        {
          sent: t('players.detail.invoiceSent', 'Invoice sent'),
          sentWithNumber: (number) =>
            t('players.detail.invoiceSentNumber', 'Invoice #{{number}}', { number }),
        },
      );
      setEmails(mergePlayerEmailHistory(campaignEmails, invoiceEmailEvents));
    } catch (err: unknown) {
      logger.error('Error loading trainer player detail', err as Error);
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }

  function handleDetailsSaved(next: TrainerPlayerDetailsValues) {
    queryClient.invalidateQueries({ queryKey: trainerPlayersQueryKey(trainerId) });
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
                {/* Phase 3.3d: the HUMAN's account status, not the clicked seat (see AcademyPlayerDetail). */}
                {(personHasLogin ?? player.type === 'registered')
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
                  if (status === 'paid' || status === 'cancelled' || status === 'draft' || status === 'void') {
                    return false;
                  }
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
              {locationNames.length > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" /> {locationNames.join(', ')}
                </span>
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
            {trainerId && canEdit && (
              <div className="pt-2">
                <TagPicker
                  trainerId={trainerId}
                  playerKey={{
                    guest_player_id: player.guest_player_id,
                    profile_id: player.profile_id,
                  }}
                  tags={tags}
                  selectedTagIds={tagIds}
                  onTagsChange={setTags}
                  onSelectedTagIdsChange={setTagIds}
                  onChanged={() =>
                    invalidateAllPlayerData(queryClient, { kind: 'trainer', id: trainerId })
                  }
                  variant="detail"
                />
              </div>
            )}
            {/* View-only trainers still SEE the tags, as static chips. */}
            {trainerId && !canEdit && tags.some((tag) => tagIds.includes(tag.id)) && (
              <div className="flex flex-wrap gap-1 pt-2">
                {tags.filter((tag) => tagIds.includes(tag.id)).map((tag) => (
                  <Badge key={tag.id} variant="secondary" className={cn('text-[10px]', getTagColorClass(tag.color))}>
                    {tag.name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          {/* Create-invoice + merge are editing/money actions — hidden for
              view-only academy trainers. */}
          {canEdit && (
            <div className="shrink-0 md:self-start flex flex-col items-stretch gap-2">
              <Button asChild data-testid="trainer-player-create-invoice" aria-label={t('players.detail.createInvoice', 'Create invoice')}>
                <Link to={getTrainerCreateInvoiceUrl(playerId)}>
                  <FileText className="h-4 w-4 mr-2" />
                  {t('players.detail.createInvoice', 'Create invoice')}
                </Link>
              </Button>
              {player.type === 'guest' && player.guest_player_id && (
                <Button
                  variant="outline"
                  data-testid="trainer-player-merge-button"
                  disabled
                  aria-disabled="true"
                  data-merge-available="false"
                  title={t(
                    PLAYER_MERGE_UNAVAILABLE_I18N.bodyKey,
                    PLAYER_MERGE_UNAVAILABLE_I18N.bodyDefault,
                  )}
                >
                  <Merge className="h-4 w-4 mr-2" />
                  {t(
                    PLAYER_MERGE_UNAVAILABLE_I18N.titleKey,
                    PLAYER_MERGE_UNAVAILABLE_I18N.titleDefault,
                  )}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <RatingTrendCard
        history={ratingHistory}
        ratingSystem={player.rating_system}
        currentRating={player.skill_rating}
        // Phase 3.5c: badge keys on person-level login (falls back to seat pre-deploy)
        isGuest={!(personHasLogin ?? player.type === 'registered')}
        t={t}
      />

      <Card data-testid="trainer-player-summary" className={flushOnMobileCardClass()}>
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

      {canEdit && detailsValues && trainerId && (
        <TrainerPlayerDetailsCard
          kind={player.type}
          trainerProfileId={trainerId}
          guestPlayerId={player.guest_player_id}
          profileId={player.profile_id}
          values={detailsValues}
          locations={trainerLocations}
          tagIds={tagIds}
          onSaved={handleDetailsSaved}
        />
      )}
      {/* View-only trainers still SEE their internal note (read-only), since the
          editable details card above is hidden for them. */}
      {!canEdit && detailsValues?.notes?.trim() && (
        <Card data-testid="trainer-player-notes-readonly" className={flushOnMobileCardClass()}>
          <CardHeader>
            <CardTitle className="text-base">{t('players.notesLabel', 'Internal notes')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{detailsValues.notes}</p>
          </CardContent>
        </Card>
      )}

      <Card data-testid="trainer-player-section-cycles" className={flushOnMobileCardClass()}>
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
            cycluses.map((c) => (
              <Link
                key={c.cyclus_id}
                to={c.href}
                data-testid={`trainer-player-cycle-link-${c.cyclus_id}`}
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

      {/* Invoices are academy-managed money — hidden for view-only trainers
          (the /app/trainer/invoices routes are restricted for them too). */}
      {canEdit && (
      <Card data-testid="trainer-player-section-invoices" className={flushOnMobileCardClass()}>
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
            invoices.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-3 p-4 transition-colors hover:bg-muted/50"
              >
                <Link
                  to={buildTrainerInvoiceEditPath(inv.id)}
                  data-testid={`trainer-player-invoice-link-${inv.id}`}
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
      )}

      <Card data-testid="trainer-player-section-rating">
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
                <LineChart
                  data={ratingHistory.map((r) => ({
                    ...r,
                    label: format(new Date(r.date), 'MMM yyyy'),
                  }))}
                >
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

      <Card data-testid="trainer-player-section-emails" className={flushOnMobileCardClass()}>
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
                  data-testid={`trainer-player-email-link-${e.id}`}
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
                  data-testid={`trainer-player-email-${e.id}`}
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

      {trainerId && parsed.kind && parsed.id && (
        <PlayerNotificationTimelineCard
          scope="trainer"
          scopeId={trainerId}
          guestId={parsed.kind === 'guest' ? parsed.id : null}
          profileId={parsed.kind === 'profile' ? parsed.id : null}
        />
      )}

      {canEdit && trainerId && player && parsed.kind && (
        <TrainerPlayerRemoveCard
          kind={parsed.kind === 'guest' ? 'guest' : 'registered'}
          trainerProfileId={trainerId}
          guestPlayerId={player.guest_player_id}
          profileId={player.profile_id}
          playerName={player.full_name}
          removedAt={removedAt}
        />
      )}

      {canEdit && trainerId && player.guest_player_id && (
        <MergePlayersDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          scope={{ kind: 'trainer', id: trainerId }}
          currentPlayer={{ guestPlayerId: player.guest_player_id, full_name: player.full_name }}
          onMerged={(targetGuestId) => {
            if (targetGuestId === player.guest_player_id) {
              // Current player survived as the target — refresh in place.
              void loadAll();
            } else {
              // Current player was the deleted source — go to the survivor.
              navigate(`/app/trainer/players/g_${targetGuestId}`);
            }
          }}
        />
      )}
    </div>
  );
}
