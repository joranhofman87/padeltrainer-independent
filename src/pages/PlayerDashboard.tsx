import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { Search, Calendar, Star, User, LogOut, TrendingUp } from 'lucide-react';

export default function PlayerDashboard() {
  const { user, profile, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (!role) {
        navigate('/select-role');
      } else if (role !== 'player') {
        navigate('/trainer');
      }
    }
  }, [user, role, loading, navigate]);

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } else {
      navigate('/auth');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const initials = profile?.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'U';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🎾</span>
            <span className="font-bold text-xl">PadelMatch</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Avatar className="h-9 w-9">
                <AvatarImage src={profile?.avatar_url || undefined} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className="font-medium hidden sm:inline">{profile?.full_name || 'Player'}</span>
            </div>
            <Button variant="ghost" size="icon" onClick={handleSignOut}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Welcome Section */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">
            Welcome back, {profile?.full_name?.split(' ')[0] || 'Player'}! 👋
          </h1>
          <p className="text-muted-foreground">
            Find your next training session and improve your padel skills
          </p>
        </div>

        {/* Rating Card */}
        <Card className="mb-8 bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-blue-100 text-sm mb-1">Your Skill Rating</p>
                <div className="flex items-center gap-2">
                  <span className="text-4xl font-bold">
                    {profile?.skill_rating || '—'}
                  </span>
                  {profile?.knltb_number && (
                    <span className="text-xs bg-white/20 px-2 py-1 rounded">
                      KNLTB
                    </span>
                  )}
                </div>
              </div>
              <TrendingUp className="h-12 w-12 text-blue-200" />
            </div>
            {!profile?.skill_rating && (
              <p className="text-blue-100 text-sm mt-3">
                Add your KNLTB rating or ask a trainer to set your level
              </p>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <div className="grid md:grid-cols-3 gap-4 mb-8">
          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/trainers')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Search className="h-5 w-5 text-primary" />
                </div>
                <CardTitle className="text-lg">Find Trainers</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Browse all available trainers and find the perfect match for your skill level
              </CardDescription>
            </CardContent>
          </Card>

          <Card className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <Calendar className="h-5 w-5 text-green-600" />
                </div>
                <CardTitle className="text-lg">My Bookings</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                View your upcoming lessons and manage your training schedule
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/profile/edit')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-500/10">
                  <User className="h-5 w-5 text-orange-600" />
                </div>
                <CardTitle className="text-lg">My Profile</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Update your profile, add your KNLTB rating, and manage preferences
              </CardDescription>
            </CardContent>
          </Card>
        </div>

        {/* Featured Trainers Placeholder */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Star className="h-5 w-5 text-yellow-500" />
              Featured Trainers
            </CardTitle>
            <CardDescription>
              Top-rated trainers in your area
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8 text-muted-foreground">
              <p>Trainer discovery coming soon!</p>
              <p className="text-sm">You'll be able to browse and book trainers here.</p>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
