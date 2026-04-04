import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, UserPlus, Search, Upload, MoreVertical, Pencil, Trash2, Mail, Phone, MapPin, BarChart3, RefreshCw } from 'lucide-react';
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
import { EditPlayerDialog } from '@/components/trainer/EditPlayerDialog';
import { ImportPlayersDialog } from '@/components/trainer/ImportPlayersDialog';
import { useSearchParams } from 'react-router-dom';

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
  trainer_name?: string;
  originalGuest?: GuestPlayer;
  location_names?: string[];
  has_active_cyclus?: boolean;
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
  const [allLocations, setAllLocations] = useState<{ id: string; name: string }[]>([]);

  // Dialogs
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showImportPlayers, setShowImportPlayers] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<GuestPlayer | null>(null);
  const [deletingPlayer, setDeletingPlayer] = useState<GuestPlayer | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Fetch trainers
  useEffect(() => {
    if (!activeAcademy) return;
    fetchTrainers();
  }, [activeAcademy]);

  // Fetch players when trainers are loaded or academy changes
  useEffect(() => {
    if (activeAcademy) {
      fetchPlayers();
    }
  }, [trainers, activeAcademy]);

  // Filter by search query, selected trainer, and new filters
  useEffect(() => {
    let result = players;

    if (selectedTrainerId && selectedTrainerId !== 'all') {
      result = result.filter((p) => p.trainer_id === selectedTrainerId);
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
  }, [searchQuery, players, selectedTrainerId, selectedLocation, selectedLevel, selectedCyclus]);

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
            .select('id, location_id, cyclus_id, end_time')
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
      }

      const guests: UnifiedPlayer[] = allGuestPlayers.map((g: any) => ({
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
        trainer_name: g.trainer_id ? (trainerNameMap.get(g.trainer_id) || '—') : t('nav.academy', 'Academy'),
        originalGuest: g as GuestPlayer,
        location_names: guestLocationMap.has(g.id) ? Array.from(guestLocationMap.get(g.id)!) : [],
        has_active_cyclus: guestCyclusMap.get(g.id) || false,
      }));

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
          const playerMap = new Map<string, { created_at: string; trainer_id: string; locations: Set<string>; has_active_cyclus: boolean }>();
          bookings.forEach((b) => {
            if (!b.player_id) return;
            const slot = slotDetailMap.get(b.slot_id);
            if (!playerMap.has(b.player_id)) {
              playerMap.set(b.player_id, {
                created_at: b.created_at,
                trainer_id: slotTrainerMap.get(b.slot_id) || '',
                locations: new Set(),
                has_active_cyclus: false,
              });
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
                  trainer_id: info?.trainer_id,
                  trainer_name: trainerNameMap.get(info?.trainer_id || '') || '—',
                  location_names: info ? Array.from(info.locations) : [],
                  has_active_cyclus: info?.has_active_cyclus || false,
                };
              });
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
    <div className="container mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t('nav.players')}</h1>
        <p className="text-muted-foreground">
          {players.length} {players.length === 1 ? 'player' : 'players'}
        </p>
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
        <TabsContent value="all-players" className="space-y-4 mt-4">
          {/* Filters row */}
          <div className="flex flex-wrap items-center gap-2">
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

            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={tTrainer('players.searchPlayers')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            <div className="flex gap-2 ml-auto">
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
              <CardHeader>
                <CardTitle>{tTrainer('players.guestPlayers')}</CardTitle>
                <CardDescription>
                  {tTrainer('players.guestPlayersDescription', { count: filteredPlayers.length })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tTrainer('players.name')}</TableHead>
                      <TableHead>{tTrainer('players.contact')}</TableHead>
                      <TableHead>{tTrainer('players.skillRating')}</TableHead>
                      <TableHead>{tTrainer('players.trainer', 'Trainer')}</TableHead>
                      <TableHead>{tTrainer('players.status')}</TableHead>
                      <TableHead>{tTrainer('players.addedOn')}</TableHead>
                      <TableHead className="w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPlayers.map((player) => (
                      <TableRow key={player.id}>
                        <TableCell>
                          <div className="font-medium">{player.full_name}</div>
                          {player.notes && (
                            <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                              {player.notes}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {player.email && (
                              <div className="flex items-center gap-1 text-sm">
                                <Mail className="h-3 w-3 text-muted-foreground" />
                                <span>{player.email}</span>
                              </div>
                            )}
                            {player.phone && (
                              <div className="flex items-center gap-1 text-sm">
                                <Phone className="h-3 w-3 text-muted-foreground" />
                                <span>{player.phone}</span>
                              </div>
                            )}
                            {!player.email && !player.phone && <span className="text-muted-foreground">—</span>}
                          </div>
                        </TableCell>
                        <TableCell>
                          {player.skill_rating ? (
                            <div className="flex items-center gap-1">
                              <Badge variant="secondary">{player.skill_rating.toFixed(1)}</Badge>
                              <span className="text-xs text-muted-foreground uppercase">
                                {player.rating_system || 'knltb'}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {player.trainer_name}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {player.type === 'registered' ? (
                              <Badge variant="default">{tTrainer('players.statuses.registered')}</Badge>
                            ) : player.has_trained ? (
                              <Badge variant="secondary">{tTrainer('players.statuses.active')}</Badge>
                            ) : (
                              <Badge variant="outline">{tTrainer('players.statuses.prospect')}</Badge>
                            )}
                            {player.has_active_cyclus && (
                              <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                                <RefreshCw className="h-3 w-3 mr-1" />
                                Cyclus
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(player.created_at), 'MMM d, yyyy')}
                        </TableCell>
                        <TableCell>
                          {player.type === 'guest' && player.originalGuest ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
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
                  academyId={academyProfileId || undefined}
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
          <Card>
            <CardContent className="py-12 text-center">
              <Mail className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">
                {tTrainer('players.emailCampaignTitle', 'Email Campaigns')}
              </h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                {tTrainer('players.emailCampaignDescription', 'Send targeted emails to your players based on their level, location, or cyclus status. Coming soon.')}
              </p>
              <Badge variant="secondary" className="mt-4">Coming soon</Badge>
            </CardContent>
          </Card>
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
    </div>
  );
}
