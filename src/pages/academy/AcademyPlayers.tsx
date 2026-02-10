import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { format } from 'date-fns';

interface PlayerRow {
  id: string;
  full_name: string;
  email?: string;
  has_trained: boolean;
  created_at: string;
  isRegistered: boolean;
}

export default function AcademyPlayers() {
  const { t } = useTranslation('academy');
  const { t: tTrainer } = useTranslation('trainer');
  const { activeAcademy } = useAcademyContext();
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeAcademy) return;
    fetchPlayers();
  }, [activeAcademy]);

  const fetchPlayers = async () => {
    if (!activeAcademy) return;
    setLoading(true);

    try {
      // Get academy trainer IDs
      const { data: academyTrainers } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('academy_profile_id', activeAcademy.id)
        .eq('status', 'active');

      const trainerIds = academyTrainers?.map(t => t.trainer_profile_id) || [];

      if (trainerIds.length === 0) {
        setPlayers([]);
        setLoading(false);
        return;
      }

      // Fetch guest players
      const { data: guestPlayers } = await supabase
        .from('guest_players')
        .select('id, full_name, email, has_trained, created_at')
        .in('trainer_id', trainerIds)
        .order('created_at', { ascending: false });

      // Fetch registered players from bookings
      const { data: registeredBookings } = await supabase
        .from('bookings')
        .select(`
          id, created_at, player_id,
          profiles:player_id (id, full_name, email),
          availability_slots!inner (trainer_id)
        `)
        .in('availability_slots.trainer_id', trainerIds)
        .not('player_id', 'is', null)
        .order('created_at', { ascending: false });

      // Deduplicate registered players
      const seenPlayerIds = new Set<string>();
      const registeredPlayers: PlayerRow[] = [];
      for (const b of registeredBookings || []) {
        const profile = b.profiles as any;
        if (profile?.id && !seenPlayerIds.has(profile.id)) {
          seenPlayerIds.add(profile.id);
          registeredPlayers.push({
            id: profile.id,
            full_name: profile.full_name || '—',
            email: profile.email,
            has_trained: true,
            created_at: b.created_at,
            isRegistered: true,
          });
        }
      }

      const guests: PlayerRow[] = (guestPlayers || []).map(g => ({
        id: g.id,
        full_name: g.full_name,
        email: g.email,
        has_trained: g.has_trained,
        created_at: g.created_at,
        isRegistered: false,
      }));

      const allPlayers = [...guests, ...registeredPlayers]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      setPlayers(allPlayers);
    } catch (error) {
      logger.error('Error fetching academy players', error as Error, {
        component: 'AcademyPlayers',
        academyId: activeAcademy.id,
      });
    } finally {
      setLoading(false);
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
    <div className="container mx-auto px-4 py-8">
      {players.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">{tTrainer('players.empty', 'No players yet')}</h3>
            <p className="text-muted-foreground">{tTrainer('players.emptyDescription', 'Players will appear here once they book with your trainers.')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('nav.players')}</CardTitle>
            <CardDescription>
              {players.length} {players.length === 1 ? 'player' : 'players'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tTrainer('players.name')}</TableHead>
                  <TableHead>{tTrainer('players.email', 'Email')}</TableHead>
                  <TableHead>{tTrainer('players.addedOn', 'Added')}</TableHead>
                  <TableHead>{tTrainer('players.type', 'Type')}</TableHead>
                  <TableHead>{tTrainer('players.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {players.map(player => (
                  <TableRow key={player.id}>
                    <TableCell className="font-medium">{player.full_name}</TableCell>
                    <TableCell className="text-muted-foreground">{player.email || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{format(new Date(player.created_at), 'dd MMM yyyy')}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {player.isRegistered ? tTrainer('players.registered', 'Registered') : tTrainer('players.guest', 'Guest')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={player.has_trained ? 'default' : 'secondary'} className="text-xs">
                        {player.has_trained ? tTrainer('players.active') : tTrainer('players.prospect')}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
