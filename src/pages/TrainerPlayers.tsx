import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Users, UserPlus, Upload, MoreVertical, Pencil, Trash2, Mail, RefreshCw, Columns3, Tags } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuCheckboxItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { usePlayerSort, SortableHeader } from '@/components/players/usePlayerSort';
import { AddPlayerDialog, GuestPlayer } from '@/components/trainer/AddPlayerDialog';
import { AddPlayerForm } from '@/components/trainer/AddPlayerForm';
import { EditPlayerDialog } from '@/components/trainer/EditPlayerDialog';
import { ImportPlayersDialog } from '@/components/trainer/ImportPlayersDialog';
import { PageHeader } from '@/components/ui/page-header';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { EmailCampaignTab } from '@/components/players/EmailCampaignTab';
import { PlayerTagsCell } from '@/components/players/PlayerTagsCell';
import { PlayerNotesCell } from '@/components/players/PlayerNotesCell';
import { ManagePlayerTagsDialog } from '@/components/players/ManagePlayerTagsDialog';
import { PlayerTag, PlayerMetadata, getTagColorClass } from '@/components/players/playerTagColors';
import { cn } from '@/lib/utils';

type UnifiedPlayer = {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  skill_rating: number | null;
  rating_system: string;
  has_trained: boolean;
  notes: string | null;
  created_at: string;
  type: 'guest' | 'registered';
  originalGuest?: GuestPlayer;
  location_names?: string[];
  has_active_cyclus?: boolean;
  source?: string | null;
  birth_date?: string | null;
  // Tags / metadata
  metadata_id?: string;
  tag_ids?: string[];
  trainer_notes?: string;
  guest_player_id?: string | null;
  profile_id?: string | null;
  has_overdue_payment?: boolean;
};

function getLevelBand(rating: number | null): string {
  if (rating === null) return 'unrated';
  if (rating <= 3) return 'beginner';
  if (rating <= 6) return 'intermediate';
  if (rating <= 9) return 'advanced';
  return 'pro';
}

function getLevelLabel(band: string): string {
  switch (band) {
    case 'beginner': return 'Beginner (1-3)';
    case 'intermediate': return 'Intermediate (4-6)';
    case 'advanced': return 'Advanced (7-9)';
    case 'pro': return 'Pro (9+)';
    case 'unrated': return 'Unrated';
    default: return band;
  }
}

export default function TrainerPlayers() {
  const { t } = useTranslation('trainer');
  const { user } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = searchParams.get('tab') || 'all-players';
  const setActiveTab = (tab: string) => setSearchParams({ tab });

  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [players, setPlayers] = useState<UnifiedPlayer[]>([]);
  const [filteredPlayers, setFilteredPlayers] = useState<UnifiedPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Filters
  const [selectedLocation, setSelectedLocation] = useState<string>('all');
  const [selectedLevel, setSelectedLevel] = useState<string>('all');
  const [selectedCyclus, setSelectedCyclus] = useState<string>('all');
  const [selectedTagId, setSelectedTagId] = useState<string>('all');
  const [selectedPaymentStatus, setSelectedPaymentStatus] = useState<string>('all');
  const [overdueGuestIds, setOverdueGuestIds] = useState<Set<string>>(new Set());
  const [overdueProfileIds, setOverdueProfileIds] = useState<Set<string>>(new Set());
  const [allLocations, setAllLocations] = useState<{ id: string; name: string }[]>([]);

  // Tags
  const [tags, setTags] = useState<PlayerTag[]>([]);
  const [metadata, setMetadata] = useState<PlayerMetadata[]>([]);
  const [showManageTags, setShowManageTags] = useState(false);

  // Dialogs
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showImportPlayers, setShowImportPlayers] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<GuestPlayer | null>(null);
  const [deletingPlayer, setDeletingPlayer] = useState<GuestPlayer | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Column customization
  type ColumnKey =
    | 'email' | 'phone' | 'location' | 'addedOn'
    | 'skill' | 'status' | 'cyclus' | 'type' | 'notes' | 'source' | 'birthDate' | 'tags' | 'internalNotes';
  const DEFAULT_COLUMNS: ColumnKey[] = ['tags', 'internalNotes', 'email', 'phone', 'location', 'addedOn'];
  const ALL_COLUMNS: { key: ColumnKey; label: string; isDefault: boolean }[] = [
    { key: 'tags', label: t('players.columns.tags', 'Tags'), isDefault: true },
    { key: 'internalNotes', label: t('players.columns.internalNotes', 'Internal notes'), isDefault: true },
    { key: 'email', label: t('players.columns.email', 'Email'), isDefault: true },
    { key: 'phone', label: t('players.columns.phone', 'Phone'), isDefault: true },
    { key: 'location', label: t('players.columns.location', 'Location'), isDefault: true },
    { key: 'addedOn', label: t('players.columns.addedOn', 'Date added'), isDefault: true },
    { key: 'skill', label: t('players.columns.skill', 'Skill rating'), isDefault: false },
    { key: 'status', label: t('players.columns.status', 'Status'), isDefault: false },
    { key: 'cyclus', label: t('players.columns.cyclus', 'In active cyclus'), isDefault: false },
    { key: 'type', label: t('players.columns.type', 'Type'), isDefault: false },
    { key: 'notes', label: t('players.columns.notes', 'Notes (intake)'), isDefault: false },
    { key: 'source', label: t('players.columns.source', 'Source'), isDefault: false },
    { key: 'birthDate', label: t('players.columns.birthDate', 'Birth date'), isDefault: false },
  ];
  const storageKey = trainerId ? `trainerPlayers:visibleColumns:${trainerId}` : null;
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);

  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as ColumnKey[];
        const valid = parsed.filter((k) => ALL_COLUMNS.some((c) => c.key === k));
        if (valid.length) setVisibleColumns(valid);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const toggleColumn = (key: ColumnKey) => {
    setVisibleColumns((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      if (storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      }
      return next;
    });
  };

  const isColVisible = (key: ColumnKey) => visibleColumns.includes(key);

  // Resolve trainerId
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (data) setTrainerId(data.id);
    })();
  }, [user]);

  useEffect(() => {
    if (!trainerId) return;
    fetchTagsAndMetadata();
    fetchOverduePayments();
    fetchPlayers();
  }, [trainerId]);

  const fetchTagsAndMetadata = async () => {
    if (!trainerId) return;
    const [tagsRes, metaRes] = await Promise.all([
      supabase.from('academy_player_tags').select('*').eq('trainer_profile_id', trainerId).order('name'),
      supabase.from('academy_player_metadata').select('id, guest_player_id, profile_id, notes, tag_ids').eq('trainer_profile_id', trainerId),
    ]);
    setTags((tagsRes.data || []) as PlayerTag[]);
    setMetadata((metaRes.data || []) as PlayerMetadata[]);
  };

  const fetchOverduePayments = async () => {
    if (!trainerId) return;
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from('invoices')
      .select('guest_player_id, player_id, status, due_date, paid_at')
      .eq('trainer_id', trainerId);
    const guests = new Set<string>();
    const profiles = new Set<string>();
    for (const inv of (data || []) as any[]) {
      const status = (inv.status || '').toLowerCase();
      const isPaid = status === 'paid' || !!inv.paid_at;
      const isClosed = status === 'cancelled' || status === 'draft' || status === 'void';
      const explicitlyOverdue = status === 'overdue';
      const pastDue = inv.due_date && inv.due_date < todayIso && !isPaid && !isClosed;
      if (explicitlyOverdue || pastDue) {
        if (inv.guest_player_id) guests.add(inv.guest_player_id);
        if (inv.player_id) profiles.add(inv.player_id);
      }
    }
    setOverdueGuestIds(guests);
    setOverdueProfileIds(profiles);
  };

  // Filter
  useEffect(() => {
    const metaByGuest = new Map<string, PlayerMetadata>();
    const metaByProfile = new Map<string, PlayerMetadata>();
    metadata.forEach((m) => {
      if (m.guest_player_id) metaByGuest.set(m.guest_player_id, m);
      if (m.profile_id) metaByProfile.set(m.profile_id, m);
    });

    let result = players.map((p) => {
      const meta = p.type === 'guest'
        ? metaByGuest.get(p.id)
        : metaByProfile.get(p.id.replace(/^reg-/, ''));
      const guestId = p.type === 'guest' ? p.id : null;
      const profileId = p.type === 'registered' ? p.id.replace(/^reg-/, '') : null;
      return {
        ...p,
        tag_ids: meta?.tag_ids || [],
        trainer_notes: meta?.notes || '',
        metadata_id: meta?.id,
        guest_player_id: guestId,
        profile_id: profileId,
        has_overdue_payment:
          (guestId && overdueGuestIds.has(guestId)) ||
          (profileId && overdueProfileIds.has(profileId)) || false,
      };
    });

    if (selectedLocation !== 'all') {
      result = result.filter((p) => p.location_names?.includes(selectedLocation));
    }
    if (selectedLevel !== 'all') {
      result = result.filter((p) => getLevelBand(p.skill_rating) === selectedLevel);
    }
    if (selectedCyclus === 'yes') result = result.filter((p) => p.has_active_cyclus === true);
    else if (selectedCyclus === 'no') result = result.filter((p) => !p.has_active_cyclus);

    if (selectedTagId !== 'all') {
      if (selectedTagId === 'untagged') {
        result = result.filter((p) => !p.tag_ids || p.tag_ids.length === 0);
      } else {
        result = result.filter((p) => p.tag_ids?.includes(selectedTagId));
      }
    }
    if (selectedPaymentStatus === 'overdue') result = result.filter((p) => p.has_overdue_payment);
    else if (selectedPaymentStatus === 'ok') result = result.filter((p) => !p.has_overdue_payment);

    const query = searchQuery.toLowerCase().trim();
    if (query) {
      result = result.filter(
        (p) =>
          p.full_name.toLowerCase().includes(query) ||
          p.email.toLowerCase().includes(query) ||
          p.phone.includes(query)
      );
    }
    setFilteredPlayers(result);
  }, [searchQuery, players, metadata, selectedLocation, selectedLevel, selectedCyclus, selectedTagId, selectedPaymentStatus, overdueGuestIds, overdueProfileIds]);

  const { sortedPlayers, sortKey, sortDir, toggleSort } = usePlayerSort(filteredPlayers);

  const fetchPlayers = async () => {
    if (!trainerId) return;
    setLoading(true);
    try {
      // Guest players owned by this trainer
      const { data: guestData } = await supabase
        .from('guest_players')
        .select('*')
        .eq('trainer_id', trainerId)
        .order('full_name');
      const allGuests: any[] = (guestData || []);

      const guestPlayerIds = allGuests.map((g) => g.id);
      const guestLocationMap = new Map<string, Set<string>>();
      const guestCyclusMap = new Map<string, boolean>();
      const locationNameMap = new Map<string, string>();
      const now = new Date().toISOString();

      // Slots for this trainer
      const { data: slotIds } = await supabase
        .from('availability_slots')
        .select('id, location_id, cyclus_id, end_time')
        .eq('trainer_id', trainerId);
      const slotDetailMap = new Map((slotIds || []).map((s) => [s.id, s]));

      const slotLocIds = new Set<string>();
      (slotIds || []).forEach((s) => { if (s.location_id) slotLocIds.add(s.location_id); });
      if (slotLocIds.size > 0) {
        const { data: locs } = await supabase
          .from('locations')
          .select('id, name')
          .in('id', Array.from(slotLocIds));
        locs?.forEach((l) => locationNameMap.set(l.id, l.name));
      }

      if (guestPlayerIds.length > 0 && (slotIds || []).length > 0) {
        const { data: guestBookings } = await supabase
          .from('bookings')
          .select('guest_player_id, slot_id')
          .in('guest_player_id', guestPlayerIds)
          .in('slot_id', (slotIds || []).map((s) => s.id));

        guestBookings?.forEach((b) => {
          if (!b.guest_player_id) return;
          const slot = slotDetailMap.get(b.slot_id);
          if (!slot) return;
          if (slot.location_id && locationNameMap.has(slot.location_id)) {
            if (!guestLocationMap.has(b.guest_player_id)) guestLocationMap.set(b.guest_player_id, new Set());
            guestLocationMap.get(b.guest_player_id)!.add(locationNameMap.get(slot.location_id)!);
          }
          if (slot.cyclus_id && slot.end_time && slot.end_time >= now) {
            guestCyclusMap.set(b.guest_player_id, true);
          }
        });
      }

      // Fallback: preferred_location_id
      const preferredLocIds = new Set<string>();
      allGuests.forEach((g) => { if (g.preferred_location_id) preferredLocIds.add(g.preferred_location_id); });
      const missingPreferred = Array.from(preferredLocIds).filter((id) => !locationNameMap.has(id));
      if (missingPreferred.length > 0) {
        const { data: locs } = await supabase
          .from('locations')
          .select('id, name')
          .in('id', missingPreferred);
        locs?.forEach((l) => locationNameMap.set(l.id, l.name));
      }
      allGuests.forEach((g) => {
        if (!g.preferred_location_id) return;
        const name = locationNameMap.get(g.preferred_location_id);
        if (!name) return;
        if (!guestLocationMap.has(g.id)) guestLocationMap.set(g.id, new Set());
        guestLocationMap.get(g.id)!.add(name);
      });

      const guests: UnifiedPlayer[] = allGuests.map((g) => ({
        id: g.id,
        full_name: g.full_name,
        email: g.email || '',
        phone: g.phone || '',
        skill_rating: g.skill_rating ?? null,
        rating_system: g.rating_system || 'knltb',
        has_trained: g.has_trained ?? false,
        notes: g.notes || null,
        created_at: g.created_at,
        type: 'guest' as const,
        originalGuest: g as GuestPlayer,
        location_names: guestLocationMap.has(g.id) ? Array.from(guestLocationMap.get(g.id)!) : [],
        has_active_cyclus: guestCyclusMap.get(g.id) || false,
        source: g.source ?? null,
        birth_date: g.birth_date ?? null,
      }));

      // Registered players from bookings
      let regPlayers: UnifiedPlayer[] = [];
      if ((slotIds || []).length > 0) {
        const { data: bookings } = await supabase
          .from('bookings')
          .select('player_id, created_at, slot_id')
          .in('slot_id', (slotIds || []).map((s) => s.id))
          .not('player_id', 'is', null);

        if (bookings && bookings.length > 0) {
          const playerMap = new Map<string, { created_at: string; locations: Set<string>; has_active_cyclus: boolean }>();
          bookings.forEach((b) => {
            if (!b.player_id) return;
            const slot = slotDetailMap.get(b.slot_id);
            if (!playerMap.has(b.player_id)) {
              playerMap.set(b.player_id, { created_at: b.created_at, locations: new Set(), has_active_cyclus: false });
            }
            const entry = playerMap.get(b.player_id)!;
            if (slot?.location_id && locationNameMap.has(slot.location_id)) {
              entry.locations.add(locationNameMap.get(slot.location_id)!);
            }
            if (slot?.cyclus_id && slot?.end_time && slot.end_time >= now) {
              entry.has_active_cyclus = true;
            }
          });

          const playerIds = Array.from(playerMap.keys());
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name, email, phone, skill_rating, rating_system')
            .in('id', playerIds);

          if (profiles) {
            const linkedIds = new Set(
              allGuests.filter((g) => g.linked_profile_id).map((g) => g.linked_profile_id)
            );
            regPlayers = profiles
              .filter((p) => !linkedIds.has(p.id))
              .map((p) => {
                const info = playerMap.get(p.id);
                return {
                  id: `reg-${p.id}`,
                  full_name: p.full_name || 'Unknown',
                  email: p.email || '',
                  phone: (p as any).phone || '',
                  skill_rating: (p as any).skill_rating ?? null,
                  rating_system: (p as any).rating_system || 'knltb',
                  has_trained: true,
                  notes: null,
                  created_at: info?.created_at || new Date().toISOString(),
                  type: 'registered' as const,
                  location_names: info ? Array.from(info.locations) : [],
                  has_active_cyclus: info?.has_active_cyclus || false,
                };
              });
          }
        }
      }

      const all = [...guests, ...regPlayers].sort((a, b) => a.full_name.localeCompare(b.full_name));
      setPlayers(all);

      const uniqueLocations = new Map<string, string>();
      locationNameMap.forEach((name, id) => uniqueLocations.set(name, id));
      setAllLocations(Array.from(uniqueLocations.entries()).map(([name, id]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error) {
      logger.error('Error fetching trainer players', error as Error, { component: 'TrainerPlayers' });
    } finally {
      setLoading(false);
    }
  };

  const handlePlayerCreated = () => { fetchPlayers(); setShowAddPlayer(false); };
  const handlePlayersImported = () => { fetchPlayers(); };
  const handlePlayerUpdated = () => { fetchPlayers(); setEditingPlayer(null); };

  const handleDeletePlayer = async () => {
    if (!deletingPlayer) return;
    setIsDeleting(true);
    try {
      const { error } = await supabase.from('guest_players').delete().eq('id', deletingPlayer.id);
      if (error) throw error;
      setPlayers((prev) => prev.filter((p) => p.id !== deletingPlayer.id));
      toast({ title: t('players.playerDeleted'), description: t('players.playerDeletedDescription') });
    } catch (error: any) {
      logger.error('Error deleting player', error as Error, { component: 'TrainerPlayers' });
      toast({ title: t('common:error'), description: error.message, variant: 'destructive' });
    } finally {
      setIsDeleting(false);
      setDeletingPlayer(null);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Skeleton className="h-10 w-48 mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-4">
      <PageHeader
        title={t('players.title')}
        countText={`${players.length} ${players.length === 1 ? 'player' : 'players'}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setShowManageTags(true)}>
              <Tags className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">{t('players.tags.manageButton', 'Tags')}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowImportPlayers(true)}>
              <Upload className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">{t('players.import.button')}</span>
              <span className="sm:hidden">Import</span>
            </Button>
            <Button size="sm" onClick={() => setShowAddPlayer(true)}>
              <UserPlus className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">{t('players.addPlayer')}</span>
              <span className="sm:hidden">Add</span>
            </Button>
          </>
        }
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all-players" className="gap-2">
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">{t('players.allPlayers', 'All Players')}</span>
          </TabsTrigger>
          <TabsTrigger value="create" className="gap-2">
            <UserPlus className="h-4 w-4" />
            <span className="hidden sm:inline">{t('players.create', 'Create')}</span>
          </TabsTrigger>
          <TabsTrigger value="email-campaign" className="gap-2">
            <Mail className="h-4 w-4" />
            <span className="hidden sm:inline">{t('players.emailCampaign', 'Email Campaign')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all-players" className="space-y-3 mt-3">
          <TableToolbar
            searchPlaceholder={t('players.searchPlayers')}
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            trailing={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="hidden md:inline-flex">
                    <Columns3 className="mr-2 h-4 w-4" />
                    {t('players.columns.button', 'Columns')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>{t('players.columns.default', 'Default')}</DropdownMenuLabel>
                  {ALL_COLUMNS.filter((c) => c.isDefault).map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.key}
                      checked={isColVisible(c.key)}
                      onCheckedChange={() => toggleColumn(c.key)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {c.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t('players.columns.optional', 'Optional')}</DropdownMenuLabel>
                  {ALL_COLUMNS.filter((c) => !c.isDefault).map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.key}
                      checked={isColVisible(c.key)}
                      onCheckedChange={() => toggleColumn(c.key)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {c.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          >
            {allLocations.length > 0 && (
              <Select value={selectedLocation} onValueChange={setSelectedLocation}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder={t('players.allLocations', 'All Locations')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('players.allLocations', 'All Locations')}</SelectItem>
                  {allLocations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.name}>{loc.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select value={selectedLevel} onValueChange={setSelectedLevel}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder={t('players.allLevels', 'All Levels')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('players.allLevels', 'All Levels')}</SelectItem>
                <SelectItem value="beginner">{getLevelLabel('beginner')}</SelectItem>
                <SelectItem value="intermediate">{getLevelLabel('intermediate')}</SelectItem>
                <SelectItem value="advanced">{getLevelLabel('advanced')}</SelectItem>
                <SelectItem value="pro">{getLevelLabel('pro')}</SelectItem>
                <SelectItem value="unrated">{getLevelLabel('unrated')}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedCyclus} onValueChange={setSelectedCyclus}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder={t('players.activeCyclus', 'Active Cyclus')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('players.allCyclus', 'All')}</SelectItem>
                <SelectItem value="yes">{t('players.hasCyclus', 'Has Cyclus')}</SelectItem>
                <SelectItem value="no">{t('players.noCyclus', 'No Cyclus')}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedTagId} onValueChange={setSelectedTagId}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder={t('players.tags.filterAll', 'All Tags')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('players.tags.filterAll', 'All Tags')}</SelectItem>
                <SelectItem value="untagged">{t('players.tags.untagged', 'Untagged')}</SelectItem>
                {tags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>
                    <span className={cn('inline-block h-2 w-2 rounded-full mr-2', getTagColorClass(tag.color).split(' ').filter(c => c.startsWith('bg-')).join(' '))} />
                    {tag.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedPaymentStatus} onValueChange={setSelectedPaymentStatus}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder={t('players.payment.filterAll', 'Payment status')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('players.payment.filterAll', 'All payments')}</SelectItem>
                <SelectItem value="overdue">{t('players.payment.overdue', 'Overdue')}</SelectItem>
                <SelectItem value="ok">{t('players.payment.ok', 'No overdue')}</SelectItem>
              </SelectContent>
            </Select>
          </TableToolbar>

          {filteredPlayers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">
                  {searchQuery ? t('players.noPlayersFound') : t('players.empty', 'No players yet')}
                </h3>
                <p className="text-muted-foreground">
                  {searchQuery ? t('players.tryDifferentSearch') : t('players.emptyDescription', 'Players will appear here once they book with you.')}
                </p>
                {!searchQuery && (
                  <Button className="mt-4" onClick={() => setShowAddPlayer(true)}>
                    <UserPlus className="mr-2 h-4 w-4" />
                    {t('players.addPlayer')}
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                {/* Desktop Table */}
                <div className="hidden md:block">
                  <Table className="[&_td]:py-1.5 [&_td]:px-3 [&_th]:py-1 [&_th]:px-3 [&_th]:h-9 text-sm">
                    <TableHeader className="sticky top-0 bg-background z-10">
                      <TableRow>
                        <SortableHeader sortKey="name" activeKey={sortKey} direction={sortDir} onToggle={toggleSort}>
                          {t('players.name')}
                        </SortableHeader>
                        {visibleColumns.map((key) => {
                          const col = ALL_COLUMNS.find((c) => c.key === key);
                          if (!col) return null;
                          if (key === 'email') {
                            return (
                              <SortableHeader key={key} sortKey="email" activeKey={sortKey} direction={sortDir} onToggle={toggleSort}>
                                {col.label}
                              </SortableHeader>
                            );
                          }
                          if (key === 'skill') {
                            return (
                              <SortableHeader key={key} sortKey="skill" activeKey={sortKey} direction={sortDir} onToggle={toggleSort}>
                                {col.label}
                              </SortableHeader>
                            );
                          }
                          if (key === 'addedOn') {
                            return (
                              <SortableHeader key={key} sortKey="addedOn" activeKey={sortKey} direction={sortDir} onToggle={toggleSort}>
                                {col.label}
                              </SortableHeader>
                            );
                          }
                          return <TableHead key={key} className="whitespace-nowrap">{col.label}</TableHead>;
                        })}
                        <TableHead className="w-[40px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedPlayers.map((player) => (
                        <TableRow key={player.id} className="h-8">
                          <TableCell className="font-medium whitespace-nowrap max-w-[260px] truncate" title={player.full_name}>
                            <div className="flex items-center gap-1.5">
                              <span className="truncate">{player.full_name}</span>
                              {player.has_overdue_payment && (
                                <Badge variant="destructive" className="h-5 px-1.5 text-[11px] shrink-0">
                                  {t('players.payment.overdue', 'Overdue')}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          {visibleColumns.map((key) => {
                            switch (key) {
                              case 'email':
                                return (
                                  <TableCell key={key} className="whitespace-nowrap max-w-[220px] truncate" title={player.email}>
                                    {player.email || <span className="text-muted-foreground">—</span>}
                                  </TableCell>
                                );
                              case 'phone':
                                return (
                                  <TableCell key={key} className="whitespace-nowrap">
                                    {player.phone || <span className="text-muted-foreground">—</span>}
                                  </TableCell>
                                );
                              case 'location':
                                return (
                                  <TableCell key={key} className="text-muted-foreground whitespace-nowrap max-w-[180px] truncate" title={player.location_names?.join(', ') || ''}>
                                    {player.location_names && player.location_names.length > 0 ? player.location_names.join(', ') : '—'}
                                  </TableCell>
                                );
                              case 'addedOn':
                                return (
                                  <TableCell key={key} className="text-muted-foreground whitespace-nowrap">
                                    {format(new Date(player.created_at), 'dd-MM-yyyy')}
                                  </TableCell>
                                );
                              case 'skill':
                                return (
                                  <TableCell key={key} className="whitespace-nowrap">
                                    {player.skill_rating ? (
                                      <span className="inline-flex items-center gap-1">
                                        <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{player.skill_rating.toFixed(1)}</Badge>
                                        <span className="text-[11px] text-muted-foreground uppercase">{player.rating_system || 'knltb'}</span>
                                      </span>
                                    ) : <span className="text-muted-foreground">—</span>}
                                  </TableCell>
                                );
                              case 'status':
                                return (
                                  <TableCell key={key} className="whitespace-nowrap">
                                    {player.type === 'registered' ? (
                                      <Badge variant="default" className="h-5 px-1.5 text-[11px]">{t('players.statuses.registered')}</Badge>
                                    ) : player.has_trained ? (
                                      <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{t('players.statuses.active')}</Badge>
                                    ) : (
                                      <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{t('players.statuses.prospect')}</Badge>
                                    )}
                                  </TableCell>
                                );
                              case 'cyclus':
                                return (
                                  <TableCell key={key} className="whitespace-nowrap">
                                    {player.has_active_cyclus ? (
                                      <Badge variant="outline" className="h-5 px-1.5 text-[11px] border-primary/30 text-primary">
                                        <RefreshCw className="h-2.5 w-2.5 mr-1" />
                                        {t('players.columns.cyclusYes', 'Yes')}
                                      </Badge>
                                    ) : <span className="text-muted-foreground">—</span>}
                                  </TableCell>
                                );
                              case 'type':
                                return (
                                  <TableCell key={key} className="whitespace-nowrap">
                                    <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
                                      {player.type === 'guest'
                                        ? t('players.columns.typeGuest', 'Guest')
                                        : t('players.columns.typeRegistered', 'Registered')}
                                    </Badge>
                                  </TableCell>
                                );
                              case 'notes':
                                return (
                                  <TableCell key={key} className="text-muted-foreground max-w-[220px]">
                                    <div className="truncate" title={player.notes || ''}>{player.notes || '—'}</div>
                                  </TableCell>
                                );
                              case 'source':
                                return (
                                  <TableCell key={key} className="text-muted-foreground whitespace-nowrap max-w-[140px] truncate" title={player.source || ''}>
                                    {player.source || '—'}
                                  </TableCell>
                                );
                              case 'birthDate':
                                return (
                                  <TableCell key={key} className="text-muted-foreground whitespace-nowrap">
                                    {player.birth_date ? format(new Date(player.birth_date), 'dd-MM-yyyy') : '—'}
                                  </TableCell>
                                );
                              case 'tags':
                                return (
                                  <TableCell key={key} className="max-w-[240px]">
                                    {trainerId && (
                                      <PlayerTagsCell
                                        trainerId={trainerId}
                                        playerKey={{ guest_player_id: player.guest_player_id || null, profile_id: player.profile_id || null }}
                                        tags={tags}
                                        selectedTagIds={player.tag_ids || []}
                                        onChanged={fetchTagsAndMetadata}
                                      />
                                    )}
                                  </TableCell>
                                );
                              case 'internalNotes':
                                return (
                                  <TableCell key={key} className="max-w-[260px]">
                                    {trainerId && (
                                      <PlayerNotesCell
                                        trainerId={trainerId}
                                        playerKey={{ guest_player_id: player.guest_player_id || null, profile_id: player.profile_id || null }}
                                        notes={player.trainer_notes || ''}
                                        onChanged={fetchTagsAndMetadata}
                                      />
                                    )}
                                  </TableCell>
                                );
                              default:
                                return null;
                            }
                          })}
                          <TableCell className="w-[40px]">
                            {player.type === 'guest' && player.originalGuest ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" aria-label="Open actions menu" className="h-7 w-7">
                                    <MoreVertical className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => setEditingPlayer(player.originalGuest!)}>
                                    <Pencil className="mr-2 h-4 w-4" />
                                    {t('players.edit')}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => setDeletingPlayer(player.originalGuest!)} className="text-destructive">
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    {t('players.delete')}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Mobile Cards */}
                <div className="md:hidden space-y-3 p-4">
                  {sortedPlayers.map((player) => (
                    <div key={player.id} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{player.full_name}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {player.type === 'registered' ? (
                            <Badge variant="default" className="text-xs">{t('players.statuses.registered')}</Badge>
                          ) : player.has_trained ? (
                            <Badge variant="secondary" className="text-xs">{t('players.statuses.active')}</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">{t('players.statuses.prospect')}</Badge>
                          )}
                          {player.type === 'guest' && player.originalGuest && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label="Open actions menu" className="h-8 w-8">
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setEditingPlayer(player.originalGuest!)}>
                                  <Pencil className="mr-2 h-4 w-4" />
                                  {t('players.edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setDeletingPlayer(player.originalGuest!)} className="text-destructive">
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  {t('players.delete')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        {player.email && <span>{player.email}</span>}
                        {player.phone && <span>{player.phone}</span>}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {player.skill_rating && (
                          <Badge variant="secondary" className="text-xs">
                            {player.skill_rating.toFixed(1)} {player.rating_system?.toUpperCase()}
                          </Badge>
                        )}
                        {player.has_active_cyclus && (
                          <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                            <RefreshCw className="h-3 w-3 mr-1" /> Cyclus
                          </Badge>
                        )}
                        <span>{format(new Date(player.created_at), 'MMM d, yyyy')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Create Tab */}
        <TabsContent value="create" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <UserPlus className="h-5 w-5" />
                  {t('players.addPlayer')}
                </CardTitle>
                <CardDescription>
                  {t('players.addPlayerDescription', 'Add a new player to your roster.')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AddPlayerForm
                  trainerId={trainerId || undefined}
                  onPlayerCreated={() => fetchPlayers()}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Upload className="h-5 w-5" />
                  {t('players.import.button', 'Import Players')}
                </CardTitle>
                <CardDescription>
                  {t('players.import.description', 'Import multiple players at once from a CSV file.')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" onClick={() => setShowImportPlayers(true)}>
                  <Upload className="mr-2 h-4 w-4" />
                  {t('players.import.button', 'Import CSV')}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Email Campaign Tab */}
        <TabsContent value="email-campaign" className="mt-4">
          {trainerId && (() => {
            const metaByGuest = new Map<string, PlayerMetadata>();
            const metaByProfile = new Map<string, PlayerMetadata>();
            metadata.forEach((m) => {
              if (m.guest_player_id) metaByGuest.set(m.guest_player_id, m);
              if (m.profile_id) metaByProfile.set(m.profile_id, m);
            });
            return (
              <EmailCampaignTab
                trainerId={trainerId}
                trainers={[]}
                locations={allLocations}
                tags={tags}
                players={players.map((p) => {
                  const meta = p.type === 'guest'
                    ? metaByGuest.get(p.id)
                    : metaByProfile.get(p.id.replace(/^reg-/, ''));
                  return {
                    id: p.id,
                    full_name: p.full_name,
                    email: p.email,
                    skill_rating: p.skill_rating,
                    location_names: p.location_names,
                    has_active_cyclus: p.has_active_cyclus,
                    type: p.type,
                    tag_ids: meta?.tag_ids || [],
                  };
                })}
              />
            );
          })()}
        </TabsContent>
      </Tabs>

      {/* Add Player Dialog */}
      {trainerId && (
        <AddPlayerDialog
          open={showAddPlayer}
          onOpenChange={setShowAddPlayer}
          trainerId={trainerId}
          onPlayerCreated={handlePlayerCreated}
        />
      )}

      {/* Import Players Dialog */}
      {trainerId && (
        <ImportPlayersDialog
          open={showImportPlayers}
          onOpenChange={setShowImportPlayers}
          trainerId={trainerId}
          onPlayersImported={handlePlayersImported}
        />
      )}

      {/* Edit Player Dialog */}
      {editingPlayer && (
        <EditPlayerDialog
          open={!!editingPlayer}
          onOpenChange={(open) => !open && setEditingPlayer(null)}
          player={editingPlayer}
          onPlayerUpdated={handlePlayerUpdated}
        />
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingPlayer} onOpenChange={(open) => !open && setDeletingPlayer(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('players.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('players.deleteConfirmDescription', { name: deletingPlayer?.full_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeletePlayer} disabled={isDeleting}>
              {t('players.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Manage Tags Dialog */}
      {trainerId && (
        <ManagePlayerTagsDialog
          open={showManageTags}
          onOpenChange={setShowManageTags}
          trainerId={trainerId}
          tags={tags}
          onChanged={fetchTagsAndMetadata}
        />
      )}
    </div>
  );
}
