import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import {
  ArrowLeft,
  Mail,
  Phone,
  MapPin,
  Calendar,
  Cake,
  BarChart3,
  FileText,
  RefreshCw,
  Send,
  StickyNote,
  Loader2,
  ExternalLink,
  Download,
} from 'lucide-react';
import { downloadInvoicePdf } from '@/lib/downloadInvoicePdf';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { getTagColorClass, PlayerTag } from '@/components/academy/playerTagColors';
import { cn } from '@/lib/utils';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

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
}

interface InvoiceItem {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total: number | null;
  status: string | null;
  pdf_url: string | null;
}

interface RatingPoint {
  date: string;
  rating: number;
  source: string;
}

interface EmailItem {
  id: string;
  subject: string;
  status: string;
  sent_at: string | null;
  created_at: string;
  campaign_status: string | null;
}

export default function AcademyPlayerDetail() {
  const { t } = useTranslation('trainer');
  const { playerId } = useParams<{ playerId: string }>();
  const { activeAcademy } = useAcademyContext();
  const { toast } = useToast();

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
  const [internalNotes, setInternalNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [locationNames, setLocationNames] = useState<string[]>([]);

  const [cycluses, setCycluses] = useState<CyclusItem[]>([]);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [ratingHistory, setRatingHistory] = useState<RatingPoint[]>([]);
  const [emails, setEmails] = useState<EmailItem[]>([]);

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
      if (parsed.kind === 'guest') {
        const { data } = await supabase
          .from('guest_players')
          .select('id, full_name, email, phone, skill_rating, rating_system, notes, source, birth_date, created_at, linked_profile_id')
          .eq('id', parsed.id)
          .maybeSingle();
        if (data) {
          core = {
            full_name: data.full_name,
            email: data.email,
            phone: data.phone,
            skill_rating: data.skill_rating as any,
            rating_system: data.rating_system,
            notes: data.notes,
            source: data.source,
            birth_date: data.birth_date,
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
      setInternalNotes(meta?.notes || '');

      // Bookings (cycluses + locations)
      const bookingFilter = parsed.kind === 'guest'
        ? supabase.from('bookings').select('id, slot_id, status').eq('guest_player_id', parsed.id)
        : supabase.from('bookings').select('id, slot_id, status').eq('player_id', parsed.id);
      const { data: bookingsData } = await bookingFilter;
      const slotIds = Array.from(new Set((bookingsData || []).map((b: any) => b.slot_id))).filter(Boolean);

      let cycluses: CyclusItem[] = [];
      let locNames: string[] = [];
      if (slotIds.length) {
        const { data: slots } = await supabase
          .from('availability_slots')
          .select('id, cyclus_id, cyclus_name, start_time, location_id')
          .in('id', slotIds);
        const slotsArr = (slots || []) as any[];

        // Locations
        const locIds = Array.from(new Set(slotsArr.map(s => s.location_id))).filter(Boolean);
        if (locIds.length) {
          const { data: locs } = await supabase
            .from('locations')
            .select('id, name')
            .in('id', locIds);
          locNames = (locs || []).map((l: any) => l.name);
        }

        // Cycluses
        const byCyc = new Map<string, { id: string; name: string; dates: Date[] }>();
        for (const s of slotsArr) {
          const cid = s.cyclus_id || s.id;
          const cname = s.cyclus_name || t('players.detail.singleSessions', 'Single sessions');
          const cur = byCyc.get(cid) || { id: cid, name: cname, dates: [] };
          if (s.start_time) cur.dates.push(new Date(s.start_time));
          byCyc.set(cid, cur);
        }
        cycluses = Array.from(byCyc.values()).map(c => {
          const sorted = c.dates.sort((a, b) => a.getTime() - b.getTime());
          return {
            cyclus_id: c.id,
            cyclus_name: c.name,
            session_count: sorted.length,
            first_session: sorted[0]?.toISOString() || '',
            last_session: sorted[sorted.length - 1]?.toISOString() || '',
          };
        }).sort((a, b) => (b.last_session || '').localeCompare(a.last_session || ''));
      }
      setCycluses(cycluses);
      setLocationNames(locNames);

      // Invoices
      const invQuery = parsed.kind === 'guest'
        ? supabase.from('invoices').select('id, invoice_number, invoice_date, due_date, total, status, pdf_url').eq('guest_player_id', parsed.id).order('invoice_date', { ascending: false })
        : supabase.from('invoices').select('id, invoice_number, invoice_date, due_date, total, status, pdf_url').eq('player_id', parsed.id).order('invoice_date', { ascending: false });
      const { data: invs } = await invQuery;
      setInvoices((invs || []) as InvoiceItem[]);

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

      // Emails sent
      const emailAddr = core.email;
      if (emailAddr) {
        const { data: recs } = await supabase
          .from('email_campaign_recipients')
          .select('id, status, sent_at, created_at, campaign_id, email_campaigns!inner(subject, status, academy_profile_id)')
          .eq('recipient_email', emailAddr)
          .eq('email_campaigns.academy_profile_id', activeAcademy!.id)
          .order('created_at', { ascending: false });
        setEmails(
          (recs || []).map((r: any) => ({
            id: r.id,
            subject: r.email_campaigns?.subject || '—',
            status: r.status,
            sent_at: r.sent_at,
            created_at: r.created_at,
            campaign_status: r.email_campaigns?.status || null,
          }))
        );
      } else {
        setEmails([]);
      }
    } catch (err: any) {
      logger.error('Error loading player detail', err);
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  async function saveNotes() {
    if (!activeAcademy || !player) return;
    setSavingNotes(true);
    try {
      const baseQuery = supabase
        .from('academy_player_metadata')
        .select('id')
        .eq('academy_profile_id', activeAcademy.id);
      const { data: existing } = await (player.guest_player_id
        ? baseQuery.eq('guest_player_id', player.guest_player_id)
        : baseQuery.eq('profile_id', player.profile_id!)
      ).maybeSingle();

      const trimmed = internalNotes.trim() || null;
      if (existing) {
        const { error } = await supabase
          .from('academy_player_metadata')
          .update({ notes: trimmed, tag_ids: tagIds })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('academy_player_metadata')
          .insert({
            academy_profile_id: activeAcademy.id,
            guest_player_id: player.guest_player_id,
            profile_id: player.profile_id,
            notes: trimmed,
            tag_ids: tagIds,
          } as any);
        if (error) throw error;
      }
      toast({ title: t('players.detail.notesSaved', 'Notes saved') });
    } catch (err: any) {
      logger.error('Error saving notes', err);
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSavingNotes(false);
    }
  }

  async function toggleTag(tagId: string) {
    const next = tagIds.includes(tagId) ? tagIds.filter(id => id !== tagId) : [...tagIds, tagId];
    setTagIds(next);
    if (!activeAcademy || !player) return;
    try {
      const baseQuery = supabase
        .from('academy_player_metadata')
        .select('id')
        .eq('academy_profile_id', activeAcademy.id);
      const { data: existing } = await (player.guest_player_id
        ? baseQuery.eq('guest_player_id', player.guest_player_id)
        : baseQuery.eq('profile_id', player.profile_id!)
      ).maybeSingle();

      if (existing) {
        await supabase.from('academy_player_metadata').update({ tag_ids: next }).eq('id', existing.id);
      } else {
        await supabase.from('academy_player_metadata').insert({
          academy_profile_id: activeAcademy.id,
          guest_player_id: player.guest_player_id,
          profile_id: player.profile_id,
          tag_ids: next,
        } as any);
      }
    } catch (err: any) {
      logger.error('Error toggling tag', err);
    }
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

  const selectedTags = tags.filter(tg => tagIds.includes(tg.id));

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
          <Avatar className="h-20 w-20">
            <AvatarFallback className="text-xl">{initials || '?'}</AvatarFallback>
          </Avatar>
          <div className="flex-1 space-y-2">
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
            {/* Tags */}
            <div className="flex flex-wrap gap-1.5 pt-2">
              {tags.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  {t('players.tags.noneCreated', 'No tags created yet')}
                </span>
              )}
              {tags.map(tag => {
                const isSelected = tagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition',
                      getTagColorClass(tag.color),
                      !isSelected && 'opacity-40 hover:opacity-90',
                    )}
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          </div>
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

      <Tabs defaultValue="overview">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="overview">{t('players.detail.tabs.overview', 'Overview')}</TabsTrigger>
          <TabsTrigger value="cycles">
            {t('players.detail.tabs.cycles', 'Cycles')} ({cycluses.length})
          </TabsTrigger>
          <TabsTrigger value="invoices">
            {t('players.detail.tabs.invoices', 'Invoices')} ({invoices.length})
          </TabsTrigger>
          <TabsTrigger value="rating">
            {t('players.detail.tabs.rating', 'Rating')} ({ratingHistory.length})
          </TabsTrigger>
          <TabsTrigger value="emails">
            {t('players.detail.tabs.emails', 'Emails')} ({emails.length})
          </TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <StickyNote className="h-4 w-4" /> {t('players.detail.internalNotes', 'Internal notes')}
              </CardTitle>
              <CardDescription>
                {t('players.detail.internalNotesDesc', 'Private notes visible only to your academy team.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                rows={6}
                placeholder={t('players.notes.placeholder', 'Internal notes about this player...')}
              />
              <div className="flex justify-end">
                <Button onClick={saveNotes} disabled={savingNotes} size="sm">
                  {savingNotes && <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />}
                  {t('common.save', 'Save')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {player.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('players.detail.intakeNotes', 'Intake notes')}</CardTitle>
                <CardDescription>
                  {t('players.detail.intakeNotesDesc', 'Notes provided by the player during signup.')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{player.notes}</p>
              </CardContent>
            </Card>
          )}

          <Card>
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
        </TabsContent>

        {/* Cycles */}
        <TabsContent value="cycles" className="pt-4">
          <Card>
            <CardContent className="p-0 divide-y">
              {cycluses.length === 0 ? (
                <Empty icon={<RefreshCw className="h-8 w-8" />} text={t('players.detail.noCycles', 'No cycles joined yet')} />
              ) : (
                cycluses.map(c => (
                  <div key={c.cyclus_id} className="p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium">{c.cyclus_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.first_session && format(new Date(c.first_session), 'dd-MM-yyyy')}
                        {' → '}
                        {c.last_session && format(new Date(c.last_session), 'dd-MM-yyyy')}
                        {' · '}
                        {c.session_count} {t('players.detail.sessions', 'sessions')}
                      </p>
                    </div>
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/app/academy/cycles/${c.cyclus_id}`}>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Invoices */}
        <TabsContent value="invoices" className="pt-4">
          <Card>
            <CardContent className="p-0 divide-y">
              {invoices.length === 0 ? (
                <Empty icon={<FileText className="h-8 w-8" />} text={t('players.detail.noInvoices', 'No invoices yet')} />
              ) : (
                invoices.map(inv => (
                  <div key={inv.id} className="p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium">{inv.invoice_number || `#${inv.id.slice(0, 8)}`}</p>
                      <p className="text-xs text-muted-foreground">
                        {inv.invoice_date && format(new Date(inv.invoice_date), 'dd-MM-yyyy')}
                        {inv.total != null && ` · €${Number(inv.total).toFixed(2)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <InvoiceStatus status={inv.status} />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
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
        </TabsContent>

        {/* Rating */}
        <TabsContent value="rating" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4" /> {t('players.detail.ratingHistory', 'Rating history')}
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
        </TabsContent>

        {/* Emails */}
        <TabsContent value="emails" className="pt-4">
          <Card>
            <CardContent className="p-0 divide-y">
              {emails.length === 0 ? (
                <Empty icon={<Send className="h-8 w-8" />} text={t('players.detail.noEmails', 'No emails sent yet')} />
              ) : (
                emails.map(e => (
                  <div key={e.id} className="p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{e.subject}</p>
                      <p className="text-xs text-muted-foreground">
                        {e.sent_at
                          ? format(new Date(e.sent_at), 'dd-MM-yyyy HH:mm')
                          : format(new Date(e.created_at), 'dd-MM-yyyy HH:mm')}
                      </p>
                    </div>
                    <Badge variant={e.status === 'sent' ? 'default' : e.status === 'failed' ? 'destructive' : 'secondary'}>
                      {e.status}
                    </Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="py-12 flex flex-col items-center text-muted-foreground">
      {icon}
      <p className="mt-2 text-sm">{text}</p>
    </div>
  );
}

function InvoiceStatus({ status }: { status: string | null }) {
  const variant = status === 'paid' ? 'default' : status === 'overdue' ? 'destructive' : 'secondary';
  return <Badge variant={variant as any}>{status || 'draft'}</Badge>;
}

function RatingTrendCard({
  history,
  ratingSystem,
  currentRating,
  isGuest,
  t,
}: {
  history: RatingPoint[];
  ratingSystem: string | null;
  currentRating: number | null;
  isGuest: boolean;
  t: any;
}) {
  const lowerIsBetter = (ratingSystem || 'knltb').toLowerCase() === 'knltb';
  const systemLabel = (ratingSystem || 'knltb').toUpperCase();

  if (!history || history.length < 2) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" /> {t('players.detail.ratingProgress', 'Rating progress')}
            <span className="text-xs font-normal text-muted-foreground">({systemLabel})</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {isGuest
              ? t('players.detail.ratingGuestHint', 'Rating history is tracked for registered players.')
              : t('players.detail.ratingNotEnough', 'Not enough rating history to show a trend yet.')}
            {currentRating != null && (
              <span className="ml-1">
                {t('players.detail.currentRating', 'Current')}:{' '}
                <span className="font-semibold text-foreground">{currentRating.toFixed(1)}</span>
              </span>
            )}
          </p>
        </CardContent>
      </Card>
    );
  }

  const first = history[0].rating;
  const latest = history[history.length - 1].rating;
  const rawDiff = Number((first - latest).toFixed(2));
  const improvement = lowerIsBetter ? rawDiff : -rawDiff;
  const improved = improvement > 0;
  const declined = improvement < 0;
  const best = lowerIsBetter
    ? Math.min(...history.map(h => h.rating))
    : Math.max(...history.map(h => h.rating));

  const chartData = history.map(r => ({
    label: format(new Date(r.date), 'MMM yyyy'),
    rating: r.rating,
  }));

  const trendColor = improved
    ? 'text-green-600 dark:text-green-400'
    : declined
    ? 'text-red-600 dark:text-red-400'
    : 'text-muted-foreground';
  const TrendIcon = improved ? TrendingUp : declined ? TrendingDown : Minus;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendIcon className={cn('h-4 w-4', trendColor)} />
            {t('players.detail.ratingProgress', 'Rating progress')}
            <span className="text-xs font-normal text-muted-foreground">({systemLabel})</span>
          </CardTitle>
          {improvement !== 0 && (
            <span className={cn('text-sm font-semibold', trendColor)}>
              {improvement > 0 ? '+' : ''}
              {improvement.toFixed(1)} {t('players.detail.points', 'points')}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-md bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('players.detail.started', 'Started')}</p>
            <p className="text-lg font-semibold font-mono">{first.toFixed(1)}</p>
          </div>
          <div className="rounded-md bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('players.detail.current', 'Current')}</p>
            <p className="text-lg font-semibold font-mono">{latest.toFixed(1)}</p>
          </div>
          <div className="rounded-md bg-primary/10 p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('players.detail.best', 'Best')}</p>
            <p className="text-lg font-semibold font-mono text-primary">{best.toFixed(1)}</p>
          </div>
        </div>
        <div className="h-28">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="academyRatingGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} domain={['auto', 'auto']} reversed={lowerIsBetter} width={30} />
              <RTooltip />
              <Area
                type="monotone"
                dataKey="rating"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#academyRatingGradient)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
