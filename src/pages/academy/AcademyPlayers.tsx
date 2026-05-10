import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, UserPlus, Search, Upload, MoreVertical, Pencil, Trash2, Mail, Phone, MapPin, BarChart3, RefreshCw, Columns3, Tags } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { AddPlayerDialog, GuestPlayer } from '@/components/trainer/AddPlayerDialog';
import { AddPlayerForm } from '@/components/trainer/AddPlayerForm';
import { EditPlayerDialog } from '@/components/trainer/EditPlayerDialog';
import { ImportPlayersDialog } from '@/components/trainer/ImportPlayersDialog';
import { ImportPlayersTab } from '@/components/trainer/ImportPlayersTab';
import { useSearchParams, Link } from 'react-router-dom';
import { EmailCampaignTab } from '@/components/academy/EmailCampaignTab';
import { PlayerTagsCell } from '@/components/academy/PlayerTagsCell';
import { PlayerNotesCell } from '@/components/academy/PlayerNotesCell';
import { ManagePlayerTagsDialog } from '@/components/academy/ManagePlayerTagsDialog';
import { PlayerTag, PlayerMetadata, getTagColorClass } from '@/components/academy/playerTagColors';
import { cn } from '@/lib/utils';

interface TrainerOption {
  id: string;
  name: string;
}

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
  trainer_id?: string;
  trainer_ids?: string[];
  trainer_name?: string;
  originalGuest?: GuestPlayer;
  location_names?: string[];
  has_active_cyclus?: boolean;
  source?: string | null;
  birth_date?: string | null;
  // Tags & metadata (academy-level)
  metadata_id?: string;
  tag_ids?: string[];
  academy_notes?: string;
  // Stable keys for metadata lookup
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

export default function AcademyPlayers() {
  const { t } = useTranslation('academy');
  const { t: tTrainer } = useTranslation('trainer');
  const { activeAcademy } = useAcademyContext();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = searchParams.get('tab') || 'all-players';
  const setActiveTab = (tab: string) => {
    setSearchParams({ tab });
  };

  const [players, setPlayers] = useState<UnifiedPlayer[]>([]);
  const [filteredPlayers, setFilteredPlayers] = useState<UnifiedPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Trainer selector
  const [trainers, setTrainers] = useState<TrainerOption[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>('');

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
    | 'trainer' | 'skill' | 'status' | 'cyclus' | 'type' | 'notes' | 'source' | 'birthDate' | 'tags' | 'internalNotes';
  const DEFAULT_COLUMNS: ColumnKey[] = ['tags', 'internalNotes', 'email', 'phone', 'location', 'addedOn'];
  const ALL_COLUMNS: { key: ColumnKey; label: string; isDefault: boolean }[] = [
    { key: 'tags', label: tTrainer('players.columns.tags', 'Tags'), isDefault: true },
    { key: 'internalNotes', label: tTrainer('players.columns.internalNotes', 'Internal notes'), isDefault: true },
    { key: 'email', label: tTrainer('players.columns.email', 'Email'), isDefault: true },
    { key: 'phone', label: tTrainer('players.columns.phone', 'Phone'), isDefault: true },
    { key: 'location', label: tTrainer('players.columns.location', 'Location'), isDefault: true },
    { key: 'addedOn', label: tTrainer('players.columns.addedOn', 'Date added'), isDefault: true },
    { key: 'trainer', label: tTrainer('players.columns.trainer', 'Trainer'), isDefault: false },
    { key: 'skill', label: tTrainer('players.columns.skill', 'Skill rating'), isDefault: false },
    { key: 'status', label: tTrainer('players.columns.status', 'Status'), isDefault: false },
    { key: 'cyclus', label: tTrainer('players.columns.cyclus', 'In active cyclus'), isDefault: false },
    { key: 'type', label: tTrainer('players.columns.type', 'Type'), isDefault: false },
    { key: 'notes', label: tTrainer('players.columns.notes', 'Notes (intake)'), isDefault: false },
    { key: 'source', label: tTrainer('players.columns.source', 'Source'), isDefault: false },
    { key: 'birthDate', label: tTrainer('players.columns.birthDate', 'Birth date'), isDefault: false },
  ];
  const storageKey = activeAcademy ? `academyPlayers:visibleColumns:${activeAcademy.id}` : null;
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

  // Fetch trainers
  useEffect(() => {
    if (!activeAcademy) return;
    fetchTrainers();
    fetchTagsAndMetadata();
    fetchOverduePayments();
  }, [activeAcademy]);

  // Fetch players when trainers are loaded or academy changes
  useEffect(() => {
    if (activeAcademy) {
      fetchPlayers();
    }
  }, [trainers, activeAcademy]);

  const fetchTagsAndMetadata = async () => {
    if (!activeAcademy) return;
    const [tagsRes, metaRes] = await Promise.all([
      supabase.from('academy_player_tags').select('*').eq('academy_profile_id', activeAcademy.id).order('name'),
      supabase.from('academy_player_metadata').select('id, guest_player_id, profile_id, notes, tag_ids').eq('academy_profile_id', activeAcademy.id),
    ]);
    setTags((tagsRes.data || []) as PlayerTag[]);
    setMetadata((metaRes.data || []) as PlayerMetadata[]);
  };

  const fetchOverduePayments = async () => {
    if (!activeAcademy) return;
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from('invoices')
      .select('guest_player_id, player_id, status, due_date, paid_at')
      .eq('academy_profile_id', activeAcademy.id);
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

  // Filter by search query, selected trainer, and new filters
  useEffect(() => {
    // Build metadata lookup maps
    const metaByGuest = new Map<string, PlayerMetadata>();
    const metaByProfile = new Map<string, PlayerMetadata>();
    metadata.forEach((m) => {
      if (m.guest_player_id) metaByGuest.set(m.guest_player_id, m);
      if (m.profile_id) metaByProfile.set(m.profile_id, m);
    });

    // Enrich players with metadata
    let result = players.map((p) => {
      const meta = p.type === 'guest'
        ? metaByGuest.get(p.id)
        : metaByProfile.get(p.id.replace(/^reg-/, ''));
      const guestId = p.type === 'guest' ? p.id : null;
      const profileId = p.type === 'registered' ? p.id.replace(/^reg-/, '') : null;
      return {
        ...p,
        tag_ids: meta?.tag_ids || [],
        academy_notes: meta?.notes || '',
        metadata_id: meta?.id,
        guest_player_id: guestId,
        profile_id: profileId,
        has_overdue_payment:
          (guestId && overdueGuestIds.has(guestId)) ||
          (profileId && overdueProfileIds.has(profileId)) || false,
      };
    });

    if (selectedTrainerId && selectedTrainerId !== 'all') {
      result = result.filter((p) => p.trainer_ids?.includes(selectedTrainerId));
    }

    if (selectedLocation && selectedLocation !== 'all') {
      result = result.filter((p) => p.location_names?.includes(selectedLocation));
    }

    if (selectedLevel && selectedLevel !== 'all') {
      result = result.filter((p) => getLevelBand(p.skill_rating) === selectedLevel);
    }

    if (selectedCyclus === 'yes') {
      result = result.filter((p) => p.has_active_cyclus === true);
    } else if (selectedCyclus === 'no') {
      result = result.filter((p) => !p.has_active_cyclus);
    }

    if (selectedTagId && selectedTagId !== 'all') {
      if (selectedTagId === 'untagged') {
        result = result.filter((p) => !p.tag_ids || p.tag_ids.length === 0);
      } else {
        result = result.filter((p) => p.tag_ids?.includes(selectedTagId));
      }
    }

    if (selectedPaymentStatus === 'overdue') {
      result = result.filter((p) => p.has_overdue_payment === true);
    } else if (selectedPaymentStatus === 'ok') {
      result = result.filter((p) => !p.has_overdue_payment);
    }

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
  }, [searchQuery, players, metadata, selectedTrainerId, selectedLocation, selectedLevel, selectedCyclus, selectedTagId, selectedPaymentStatus, overdueGuestIds, overdueProfileIds]);

  const fetchTrainers = async () => {
    if (!activeAcademy) return;

    const { data: academyTrainers } = await supabase
      .from('academy_trainers')
      .select('trainer_profile_id')
      .eq('academy_profile_id', activeAcademy.id)
      .eq('status', 'active');

    const trainerIds = academyTrainers?.map((t) => t.trainer_profile_id) || [];
    if (trainerIds.length === 0) {
      setTrainers([]);
      return;
    }

    const { data: trainerProfiles } = await supabase
      .from('trainer_profiles')
      .select('id, user_id')
      .in('id', trainerIds);

    if (!trainerProfiles || trainerProfiles.length === 0) {
      setTrainers([]);
      return;
    }

    const userIds = trainerProfiles.map((tp) => tp.user_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', userIds);

    const nameMap = new Map(profiles?.map((p) => [p.user_id, p.full_name || 'Unknown']) || []);
    const opts: TrainerOption[] = trainerProfiles.map((tp) => ({
      id: tp.id,
      name: nameMap.get(tp.user_id) || 'Unknown',
    }));

    setTrainers(opts);
  };

  const fetchPlayers = async () => {
    if (!activeAcademy) return;
    setLoading(true);

    try {
      const trainerIds = trainers.map((t) => t.id);
      const trainerNameMap = new Map(trainers.map((t) => [t.id, t.name]));

      // Fetch guest players: trainer-owned (for academy trainers) + academy-level
      let allGuestPlayers: any[] = [];

      if (trainerIds.length > 0) {
        const { data: trainerPlayers } = await supabase
          .from('guest_players')
          .select('*')
          .in('trainer_id', trainerIds)
          .order('full_name');
        if (trainerPlayers) allGuestPlayers.push(...trainerPlayers);
      }

      const { data: academyPlayers } = await supabase
        .from('guest_players')
        .select('*')
        .eq('academy_profile_id', activeAcademy.id)
        .is('trainer_id', null)
        .order('full_name');
      if (academyPlayers) allGuestPlayers.push(...academyPlayers);

      // Deduplicate by id
      const seenIds = new Set<string>();
      allGuestPlayers = allGuestPlayers.filter((g) => {
        if (seenIds.has(g.id)) return false;
        seenIds.add(g.id);
        return true;
      });

      // --- Enrich guest players with location + cyclus data ---
      const guestPlayerIds = allGuestPlayers.map((g) => g.id);
      const guestLocationMap = new Map<string, Set<string>>();
      const guestCyclusMap = new Map<string, boolean>();
      const guestTrainerMap = new Map<string, Set<string>>();
      const locationNameMap = new Map<string, string>();
      const now = new Date().toISOString();

      if (guestPlayerIds.length > 0) {
        // Fetch bookings for guest players with slot details
        const { data: guestBookings } = await supabase
          .from('bookings')
          .select('guest_player_id, slot_id')
          .in('guest_player_id', guestPlayerIds);

        if (guestBookings && guestBookings.length > 0) {
          const slotIdsForGuests = [...new Set(guestBookings.map((b) => b.slot_id))];
          const { data: slotsData } = await supabase
            .from('availability_slots')
            .select('id, location_id, cyclus_id, end_time, trainer_id')
            .in('id', slotIdsForGuests);

          if (slotsData) {
            const slotMap = new Map(slotsData.map((s) => [s.id, s]));

            // Collect location ids
            const locIds = new Set<string>();
            slotsData.forEach((s) => { if (s.location_id) locIds.add(s.location_id); });

            if (locIds.size > 0) {
              const { data: locs } = await supabase
                .from('locations')
                .select('id, name')
                .in('id', Array.from(locIds));
              locs?.forEach((l) => locationNameMap.set(l.id, l.name));
            }

            guestBookings.forEach((b) => {
              if (!b.guest_player_id) return;
              const slot = slotMap.get(b.slot_id);
              if (!slot) return;

              // Track trainer
              if (slot.trainer_id) {
                if (!guestTrainerMap.has(b.guest_player_id)) guestTrainerMap.set(b.guest_player_id, new Set());
                guestTrainerMap.get(b.guest_player_id)!.add(slot.trainer_id);
              }

              if (slot.location_id && locationNameMap.has(slot.location_id)) {
                if (!guestLocationMap.has(b.guest_player_id)) guestLocationMap.set(b.guest_player_id, new Set());
                guestLocationMap.get(b.guest_player_id)!.add(locationNameMap.get(slot.location_id)!);
              }

              if (slot.cyclus_id && slot.end_time && slot.end_time >= now) {
                guestCyclusMap.set(b.guest_player_id, true);
              }
            });
          }
        }

        // Also enrich from intake_requests (registration form, no booking yet)
        const { data: guestIntakes } = await supabase
          .from('intake_requests')
          .select('guest_player_id, player_id, location_id')
          .in('guest_player_id', guestPlayerIds);

        const intakeLocIds = new Set<string>();
        guestIntakes?.forEach((r) => { if (r.location_id) intakeLocIds.add(r.location_id); });
        const missingLocIds = Array.from(intakeLocIds).filter((id) => !locationNameMap.has(id));
        if (missingLocIds.length > 0) {
          const { data: locs } = await supabase
            .from('locations')
            .select('id, name')
            .in('id', missingLocIds);
          locs?.forEach((l) => locationNameMap.set(l.id, l.name));
        }
        guestIntakes?.forEach((r) => {
          if (!r.guest_player_id || !r.location_id) return;
          const name = locationNameMap.get(r.location_id);
          if (!name) return;
          if (!guestLocationMap.has(r.guest_player_id)) guestLocationMap.set(r.guest_player_id, new Set());
          guestLocationMap.get(r.guest_player_id)!.add(name);
        });

        // Fallback: preferred_location_id stored directly on the guest record
        const preferredLocIds = new Set<string>();
        allGuestPlayers.forEach((g: any) => {
          if (g.preferred_location_id) preferredLocIds.add(g.preferred_location_id);
        });
        const missingPreferred = Array.from(preferredLocIds).filter((id) => !locationNameMap.has(id));
        if (missingPreferred.length > 0) {
          const { data: locs } = await supabase
            .from('locations')
            .select('id, name')
            .in('id', missingPreferred);
          locs?.forEach((l) => locationNameMap.set(l.id, l.name));
        }
        allGuestPlayers.forEach((g: any) => {
          if (!g.preferred_location_id) return;
          const name = locationNameMap.get(g.preferred_location_id);
          if (!name) return;
          if (!guestLocationMap.has(g.id)) guestLocationMap.set(g.id, new Set());
          guestLocationMap.get(g.id)!.add(name);
        });
      }

      const guests: UnifiedPlayer[] = allGuestPlayers.map((g: any) => {
        const bookingTrainerIds = guestTrainerMap.has(g.id) ? Array.from(guestTrainerMap.get(g.id)!) : [];
        const allTrainerIds = g.trainer_id
          ? [...new Set([g.trainer_id, ...bookingTrainerIds])]
          : bookingTrainerIds;
        return {
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
          trainer_id: g.trainer_id,
          trainer_ids: allTrainerIds,
          trainer_name: g.trainer_id ? (trainerNameMap.get(g.trainer_id) || '—') : t('nav.academy', 'Academy'),
          originalGuest: g as GuestPlayer,
          location_names: guestLocationMap.has(g.id) ? Array.from(guestLocationMap.get(g.id)!) : [],
          has_active_cyclus: guestCyclusMap.get(g.id) || false,
          source: g.source ?? null,
          birth_date: g.birth_date ?? null,
        };
      });

      // Fetch registered players from bookings
      const { data: slotIds } = await supabase
        .from('availability_slots')
        .select('id, trainer_id, location_id, cyclus_id, end_time')
        .in('trainer_id', trainerIds);

      let regPlayers: UnifiedPlayer[] = [];
      if (slotIds && slotIds.length > 0) {
        const slotTrainerMap = new Map(slotIds.map((s) => [s.id, s.trainer_id]));
        const slotDetailMap = new Map(slotIds.map((s) => [s.id, s]));

        // Collect location ids from these slots too
        const regLocIds = new Set<string>();
        slotIds.forEach((s) => { if (s.location_id) regLocIds.add(s.location_id); });
        if (regLocIds.size > 0) {
          const { data: locs } = await supabase
            .from('locations')
            .select('id, name')
            .in('id', Array.from(regLocIds));
          locs?.forEach((l) => locationNameMap.set(l.id, l.name));
        }

        const { data: bookings } = await supabase
          .from('bookings')
          .select('player_id, created_at, slot_id')
          .in('slot_id', slotIds.map((s) => s.id))
          .not('player_id', 'is', null);

        if (bookings && bookings.length > 0) {
          const playerMap = new Map<string, { created_at: string; trainer_ids: Set<string>; locations: Set<string>; has_active_cyclus: boolean }>();
          bookings.forEach((b) => {
            if (!b.player_id) return;
            const slot = slotDetailMap.get(b.slot_id);
            const trainerId = slotTrainerMap.get(b.slot_id) || '';
            if (!playerMap.has(b.player_id)) {
              playerMap.set(b.player_id, {
                created_at: b.created_at,
                trainer_ids: new Set(),
                locations: new Set(),
                has_active_cyclus: false,
              });
            }
            const entry = playerMap.get(b.player_id)!;
            if (trainerId) entry.trainer_ids.add(trainerId);
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
              allGuestPlayers
                .filter((g: any) => g.linked_profile_id)
                .map((g: any) => g.linked_profile_id)
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
                  trainer_ids: info ? Array.from(info.trainer_ids) : [],
                  trainer_name: info?.trainer_ids.size ? trainerNameMap.get(Array.from(info.trainer_ids)[0]) || '—' : '—',
                  location_names: info ? Array.from(info.locations) : [],
                  has_active_cyclus: info?.has_active_cyclus || false,
                };
              });

            // Enrich registered players' locations from intake_requests fallback
            const playerIdList = profiles.map((p) => p.id);
            if (playerIdList.length > 0) {
              const { data: regIntakes } = await supabase
                .from('intake_requests')
                .select('player_id, location_id')
                .in('player_id', playerIdList);

              const regIntakeLocIds = new Set<string>();
              regIntakes?.forEach((r) => { if (r.location_id) regIntakeLocIds.add(r.location_id); });
              const missing = Array.from(regIntakeLocIds).filter((id) => !locationNameMap.has(id));
              if (missing.length > 0) {
                const { data: locs } = await supabase
                  .from('locations')
                  .select('id, name')
                  .in('id', missing);
                locs?.forEach((l) => locationNameMap.set(l.id, l.name));
              }
              const intakeLocByPlayer = new Map<string, Set<string>>();
              regIntakes?.forEach((r) => {
                if (!r.player_id || !r.location_id) return;
                const name = locationNameMap.get(r.location_id);
                if (!name) return;
                if (!intakeLocByPlayer.has(r.player_id)) intakeLocByPlayer.set(r.player_id, new Set());
                intakeLocByPlayer.get(r.player_id)!.add(name);
              });
              regPlayers = regPlayers.map((rp) => {
                const profileId = rp.id.replace(/^reg-/, '');
                const extra = intakeLocByPlayer.get(profileId);
                if (!extra || extra.size === 0) return rp;
                const merged = new Set([...(rp.location_names || []), ...extra]);
                return { ...rp, location_names: Array.from(merged) };
              });
            }
          }
        }
      }

      const allPlayers = [...guests, ...regPlayers].sort((a, b) =>
        a.full_name.localeCompare(b.full_name)
      );
      setPlayers(allPlayers);

      // Build unique locations for filter
      const uniqueLocations = new Map<string, string>();
      locationNameMap.forEach((name, id) => uniqueLocations.set(name, id));
      setAllLocations(Array.from(uniqueLocations.entries()).map(([name, id]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error) {
      logger.error('Error fetching academy players', error as Error, {
        component: 'AcademyPlayers',
        academyId: activeAcademy.id,
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePlayerCreated = (player: GuestPlayer) => {
    fetchPlayers();
    setShowAddPlayer(false);
  };

  const handlePlayersImported = (importedPlayers: GuestPlayer[]) => {
    fetchPlayers();
  };

  const handlePlayerUpdated = (updatedPlayer: GuestPlayer) => {
    fetchPlayers();
    setEditingPlayer(null);
  };

  const handleDeletePlayer = async () => {
    if (!deletingPlayer) return;
    setIsDeleting(true);
    try {
      const { error } = await supabase
        .from('guest_players')
        .delete()
        .eq('id', deletingPlayer.id);

      if (error) throw error;

      setPlayers((prev) => prev.filter((p) => p.id !== deletingPlayer.id));
      toast({
        title: tTrainer('players.playerDeleted'),
        description: tTrainer('players.playerDeletedDescription'),
      });
    } catch (error: any) {
      logger.error('Error deleting player', error as Error, { component: 'AcademyPlayers' });
      toast({
        title: t('common:error'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
      setDeletingPlayer(null);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Skeleton className="h-10 w-48 mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-4">
      {/* Header: title + primary actions on one row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('nav.players')}</h1>
          <p className="text-sm text-muted-foreground">
            {players.length} {players.length === 1 ? 'player' : 'players'}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setShowManageTags(true)}>
            <Tags className="mr-2 h-4 w-4" />
            <span className="hidden sm:inline">{tTrainer('players.tags.manageButton', 'Tags')}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImportPlayers(true)}>
            <Upload className="mr-2 h-4 w-4" />
            <span className="hidden sm:inline">{tTrainer('players.import.button')}</span>
            <span className="sm:hidden">Import</span>
          </Button>
          <Button size="sm" onClick={() => setShowAddPlayer(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            <span className="hidden sm:inline">{tTrainer('players.addPlayer')}</span>
            <span className="sm:hidden">Add</span>
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center gap-3">
          <TabsList>
            <TabsTrigger value="all-players" className="gap-2">
              <Users className="h-4 w-4" />
              <span className="hidden sm:inline">{tTrainer('players.allPlayers', 'All Players')}</span>
            </TabsTrigger>
            <TabsTrigger value="create" className="gap-2">
              <UserPlus className="h-4 w-4" />
              <span className="hidden sm:inline">{tTrainer('players.create', 'Create')}</span>
            </TabsTrigger>
            <TabsTrigger value="email-campaign" className="gap-2">
              <Mail className="h-4 w-4" />
              <span className="hidden sm:inline">{tTrainer('players.emailCampaign', 'Email Campaign')}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* All Players Tab */}
        <TabsContent value="all-players" className="space-y-3 mt-3">
          {/* Toolbar: search first, filters next, columns at the end */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={tTrainer('players.searchPlayers')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {trainers.length > 0 && (
              <Select value={selectedTrainerId} onValueChange={setSelectedTrainerId}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder={tTrainer('players.allTrainers', 'All Trainers')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tTrainer('players.allTrainers', 'All Trainers')}</SelectItem>
                  {trainers.map((tr) => (
                    <SelectItem key={tr.id} value={tr.id}>
                      {tr.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {allLocations.length > 0 && (
              <Select value={selectedLocation} onValueChange={setSelectedLocation}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder={tTrainer('players.allLocations', 'All Locations')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tTrainer('players.allLocations', 'All Locations')}</SelectItem>
                  {allLocations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.name}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select value={selectedLevel} onValueChange={setSelectedLevel}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder={tTrainer('players.allLevels', 'All Levels')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tTrainer('players.allLevels', 'All Levels')}</SelectItem>
                <SelectItem value="beginner">{getLevelLabel('beginner')}</SelectItem>
                <SelectItem value="intermediate">{getLevelLabel('intermediate')}</SelectItem>
                <SelectItem value="advanced">{getLevelLabel('advanced')}</SelectItem>
                <SelectItem value="pro">{getLevelLabel('pro')}</SelectItem>
                <SelectItem value="unrated">{getLevelLabel('unrated')}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedCyclus} onValueChange={setSelectedCyclus}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder={tTrainer('players.activeCyclus', 'Active Cyclus')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tTrainer('players.allCyclus', 'All')}</SelectItem>
                <SelectItem value="yes">{tTrainer('players.hasCyclus', 'Has Cyclus')}</SelectItem>
                <SelectItem value="no">{tTrainer('players.noCyclus', 'No Cyclus')}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedTagId} onValueChange={setSelectedTagId}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder={tTrainer('players.tags.filterAll', 'All Tags')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tTrainer('players.tags.filterAll', 'All Tags')}</SelectItem>
                <SelectItem value="untagged">{tTrainer('players.tags.untagged', 'Untagged')}</SelectItem>
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
                <SelectValue placeholder={tTrainer('players.payment.filterAll', 'Payment status')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tTrainer('players.payment.filterAll', 'All payments')}</SelectItem>
                <SelectItem value="overdue">{tTrainer('players.payment.overdue', 'Overdue')}</SelectItem>
                <SelectItem value="ok">{tTrainer('players.payment.ok', 'No overdue')}</SelectItem>
              </SelectContent>
            </Select>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="ml-auto hidden md:inline-flex">
                  <Columns3 className="mr-2 h-4 w-4" />
                  {tTrainer('players.columns.button', 'Columns')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>{tTrainer('players.columns.default', 'Default')}</DropdownMenuLabel>
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
                <DropdownMenuLabel>{tTrainer('players.columns.optional', 'Optional')}</DropdownMenuLabel>
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
          </div>

          {/* Players Table */}
          {filteredPlayers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">
                  {searchQuery ? tTrainer('players.noPlayersFound') : tTrainer('players.empty', 'No players yet')}
                </h3>
                <p className="text-muted-foreground">
                  {searchQuery
                    ? tTrainer('players.tryDifferentSearch')
                    : tTrainer('players.emptyDescription', 'Players will appear here once they book with your trainers.')}
                </p>
                {!searchQuery && (
                  <Button className="mt-4" onClick={() => setShowAddPlayer(true)}>
                    <UserPlus className="mr-2 h-4 w-4" />
                    {tTrainer('players.addPlayer')}
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
                      <TableHead>{tTrainer('players.name')}</TableHead>
                      {visibleColumns.map((key) => {
                        const col = ALL_COLUMNS.find((c) => c.key === key);
                        if (!col) return null;
                        return <TableHead key={key} className="whitespace-nowrap">{col.label}</TableHead>;
                      })}
                      <TableHead className="w-[40px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPlayers.map((player) => (
                      <TableRow key={player.id} className="h-8">
                        <TableCell className="font-medium whitespace-nowrap max-w-[260px] truncate" title={player.full_name}>
                          <div className="flex items-center gap-1.5">
                            <Link
                              to={`/app/academy/players/${player.guest_player_id ? `g_${player.guest_player_id}` : `p_${player.profile_id}`}`}
                              className="hover:underline text-foreground truncate"
                            >
                              {player.full_name}
                            </Link>
                            {player.has_overdue_payment && (
                              <Badge variant="destructive" className="h-5 px-1.5 text-[11px] shrink-0" title={tTrainer('players.payment.overdueTooltip', 'Has overdue invoice')}>
                                {tTrainer('players.payment.overdue', 'Overdue')}
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
                                  {player.location_names && player.location_names.length > 0
                                    ? player.location_names.join(', ')
                                    : '—'}
                                </TableCell>
                              );
                            case 'addedOn':
                              return (
                                <TableCell key={key} className="text-muted-foreground whitespace-nowrap">
                                  {format(new Date(player.created_at), 'dd-MM-yyyy')}
                                </TableCell>
                              );
                            case 'trainer':
                              return (
                                <TableCell key={key} className="text-muted-foreground whitespace-nowrap max-w-[160px] truncate" title={player.trainer_name || ''}>
                                  {player.trainer_name || '—'}
                                </TableCell>
                              );
                            case 'skill':
                              return (
                                <TableCell key={key} className="whitespace-nowrap">
                                  {player.skill_rating ? (
                                    <span className="inline-flex items-center gap-1">
                                      <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{player.skill_rating.toFixed(1)}</Badge>
                                      <span className="text-[11px] text-muted-foreground uppercase">
                                        {player.rating_system || 'knltb'}
                                      </span>
                                    </span>
                                  ) : <span className="text-muted-foreground">—</span>}
                                </TableCell>
                              );
                            case 'status':
                              return (
                                <TableCell key={key} className="whitespace-nowrap">
                                  {player.type === 'registered' ? (
                                    <Badge variant="default" className="h-5 px-1.5 text-[11px]">{tTrainer('players.statuses.registered')}</Badge>
                                  ) : player.has_trained ? (
                                    <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{tTrainer('players.statuses.active')}</Badge>
                                  ) : (
                                    <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{tTrainer('players.statuses.prospect')}</Badge>
                                  )}
                                </TableCell>
                              );
                            case 'cyclus':
                              return (
                                <TableCell key={key} className="whitespace-nowrap">
                                  {player.has_active_cyclus ? (
                                    <Badge variant="outline" className="h-5 px-1.5 text-[11px] border-primary/30 text-primary">
                                      <RefreshCw className="h-2.5 w-2.5 mr-1" />
                                      {tTrainer('players.columns.cyclusYes', 'Yes')}
                                    </Badge>
                                  ) : <span className="text-muted-foreground">—</span>}
                                </TableCell>
                              );
                            case 'type':
                              return (
                                <TableCell key={key} className="whitespace-nowrap">
                                  <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
                                    {player.type === 'guest'
                                      ? tTrainer('players.columns.typeGuest', 'Guest')
                                      : tTrainer('players.columns.typeRegistered', 'Registered')}
                                  </Badge>
                                </TableCell>
                              );
                            case 'notes':
                              return (
                                <TableCell key={key} className="text-muted-foreground max-w-[220px]">
                                  <div className="truncate" title={player.notes || ''}>
                                    {player.notes || '—'}
                                  </div>
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
                                  {activeAcademy && (
                                    <PlayerTagsCell
                                      academyId={activeAcademy.id}
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
                                  {activeAcademy && (
                                    <PlayerNotesCell
                                      academyId={activeAcademy.id}
                                      playerKey={{ guest_player_id: player.guest_player_id || null, profile_id: player.profile_id || null }}
                                      notes={player.academy_notes || ''}
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
                                <Button variant="ghost" size="icon" className="h-7 w-7">
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setEditingPlayer(player.originalGuest!)}>
                                  <Pencil className="mr-2 h-4 w-4" />
                                  {tTrainer('players.edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => setDeletingPlayer(player.originalGuest!)}
                                  className="text-destructive"
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  {tTrainer('players.delete')}
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
                  {filteredPlayers.map((player) => (
                    <div key={player.id} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{player.full_name}</p>
                          {player.trainer_name && (
                            <p className="text-xs text-muted-foreground">{player.trainer_name}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {player.type === 'registered' ? (
                            <Badge variant="default" className="text-xs">{tTrainer('players.statuses.registered')}</Badge>
                          ) : player.has_trained ? (
                            <Badge variant="secondary" className="text-xs">{tTrainer('players.statuses.active')}</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">{tTrainer('players.statuses.prospect')}</Badge>
                          )}
                          {player.type === 'guest' && player.originalGuest && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8">
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setEditingPlayer(player.originalGuest!)}>
                                  <Pencil className="mr-2 h-4 w-4" />
                                  {tTrainer('players.edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setDeletingPlayer(player.originalGuest!)} className="text-destructive">
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  {tTrainer('players.delete')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        {player.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="h-3 w-3" /> {player.email}
                          </span>
                        )}
                        {player.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3" /> {player.phone}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {player.skill_rating && (
                          <Badge variant="secondary" className="text-xs">
                            {player.skill_rating.toFixed(1)} {player.rating_system?.toUpperCase()}
                          </Badge>
                        )}
                        {player.has_active_cyclus && (
                          <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                            <RefreshCw className="h-3 w-3 mr-1" />
                            Cyclus
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
                  {tTrainer('players.addPlayer')}
                </CardTitle>
                <CardDescription>
                  {tTrainer('players.addPlayerDescription', 'Add a new player to your academy.')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AddPlayerForm
                  academyId={activeAcademy?.id}
                  onPlayerCreated={() => fetchPlayers()}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Upload className="h-5 w-5" />
                  {tTrainer('players.import.button', 'Import Players')}
                </CardTitle>
                <CardDescription>
                  {tTrainer('players.import.description', 'Import multiple players at once from a CSV file.')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" onClick={() => setShowImportPlayers(true)}>
                  <Upload className="mr-2 h-4 w-4" />
                  {tTrainer('players.import.button', 'Import CSV')}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Email Campaign Tab */}
        <TabsContent value="email-campaign" className="mt-4">
          {activeAcademy && (() => {
            const metaByGuest = new Map<string, PlayerMetadata>();
            const metaByProfile = new Map<string, PlayerMetadata>();
            metadata.forEach((m) => {
              if (m.guest_player_id) metaByGuest.set(m.guest_player_id, m);
              if (m.profile_id) metaByProfile.set(m.profile_id, m);
            });
            return (
              <EmailCampaignTab
                academyId={activeAcademy.id}
                trainers={trainers}
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
                    trainer_id: p.trainer_id,
                    trainer_ids: p.trainer_ids,
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
      <AddPlayerDialog
        open={showAddPlayer}
        onOpenChange={setShowAddPlayer}
        academyId={activeAcademy?.id}
        trainerId={selectedTrainerId && selectedTrainerId !== 'all' ? selectedTrainerId : undefined}
        onPlayerCreated={handlePlayerCreated}
      />

      {/* Import Players Dialog */}
      <ImportPlayersDialog
        open={showImportPlayers}
        onOpenChange={setShowImportPlayers}
        academyId={activeAcademy?.id}
        trainerId={selectedTrainerId && selectedTrainerId !== 'all' ? selectedTrainerId : undefined}
        onPlayersImported={handlePlayersImported}
      />

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
            <AlertDialogTitle>{tTrainer('players.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tTrainer('players.deleteConfirmDescription', { name: deletingPlayer?.full_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeletePlayer} disabled={isDeleting}>
              {tTrainer('players.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Manage Tags Dialog */}
      {activeAcademy && (
        <ManagePlayerTagsDialog
          open={showManageTags}
          onOpenChange={setShowManageTags}
          academyId={activeAcademy.id}
          tags={tags}
          onChanged={fetchTagsAndMetadata}
        />
      )}
    </div>
  );
}
