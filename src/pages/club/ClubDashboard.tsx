import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { 
  Building2, 
  Users, 
  Calendar, 
  Settings, 
  AlertCircle, 
  ArrowRight,
  MapPin
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { getUserClubProfiles, getClubPlayers, getClubTrainers, type ClubProfile } from '@/lib/club';
import type { Location } from '@/lib/locations';

interface ClubWithLocation extends ClubProfile {
  role: string;
  location: Location;
}

export default function ClubDashboard() {
  const { t } = useTranslation('club');
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [clubs, setClubs] = useState<ClubWithLocation[]>([]);
  const [activeClub, setActiveClub] = useState<ClubWithLocation | null>(null);
  const [stats, setStats] = useState({ trainers: 0, players: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    async function fetchClubs() {
      if (!user) return;

      try {
        const userClubs = await getUserClubProfiles(user.id);
        setClubs(userClubs);
        
        if (userClubs.length > 0) {
          const firstClub = userClubs[0];
          setActiveClub(firstClub);
          
          // Fetch stats for first club
          const [trainersData, playersData] = await Promise.all([
            getClubTrainers(firstClub.id),
            getClubPlayers(firstClub.id),
          ]);
          
          setStats({
            trainers: trainersData.length,
            players: playersData.length,
          });
        }
      } catch (error) {
        console.error('Error fetching clubs:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchClubs();
  }, [user]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
          <div className="space-y-6">
            <Skeleton className="h-12 w-48" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (clubs.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-16 text-center">
          <Building2 className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t('dashboard.title')}</h1>
          <p className="text-muted-foreground mb-6">
            You haven't claimed any clubs yet. Visit a location page to claim your club.
          </p>
          <Button onClick={() => navigate('/locations')}>
            Browse Locations
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                <Building2 className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">{activeClub?.location.name}</h1>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <MapPin className="h-4 w-4" />
                  <span>{activeClub?.location.city}</span>
                  <Badge variant={activeClub?.is_verified ? 'default' : 'secondary'}>
                    {activeClub?.is_verified ? t('common:verified') : t('dashboard.pendingVerification')}
                  </Badge>
                </div>
              </div>
            </div>
            
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => navigate('/club/profile')}>
                {t('dashboard.profile')}
              </Button>
              <Button variant="outline" onClick={() => navigate('/club/settings')}>
                <Settings className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        {/* Verification Alert */}
        {activeClub && !activeClub.is_verified && (
          <Alert className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{t('dashboard.pendingVerification')}</AlertTitle>
            <AlertDescription>
              {t('dashboard.pendingVerificationDescription')}
            </AlertDescription>
          </Alert>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/club/trainers')}>
            <CardHeader className="pb-2">
              <CardDescription>{t('stats.trainers')}</CardDescription>
              <CardTitle className="text-3xl">{stats.trainers}</CardTitle>
            </CardHeader>
            <CardContent>
              <Button variant="ghost" size="sm" className="p-0 h-auto">
                {t('trainers.title')} <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </CardContent>
          </Card>

          <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/club/players')}>
            <CardHeader className="pb-2">
              <CardDescription>{t('stats.players')}</CardDescription>
              <CardTitle className="text-3xl">{stats.players}</CardTitle>
            </CardHeader>
            <CardContent>
              <Button variant="ghost" size="sm" className="p-0 h-auto">
                {t('players.title')} <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </CardContent>
          </Card>

          <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/club/calendar')}>
            <CardHeader className="pb-2">
              <CardDescription>{t('stats.upcomingSessions')}</CardDescription>
              <CardTitle className="text-3xl">-</CardTitle>
            </CardHeader>
            <CardContent>
              <Button variant="ghost" size="sm" className="p-0 h-auto">
                {t('dashboard.calendar')} <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Quick Actions */}
        <h2 className="text-lg font-semibold mb-4">{t('dashboard.overview')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                {t('trainers.title')}
              </CardTitle>
              <CardDescription>{t('trainers.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => navigate('/club/trainers')}>
                {t('trainers.title')} <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                {t('players.title')}
              </CardTitle>
              <CardDescription>{t('players.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => navigate('/club/players')}>
                {t('players.title')} <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
