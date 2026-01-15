import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useEffect } from 'react';
import { ArrowRight, Users, GraduationCap, Star, MapPin } from 'lucide-react';

export default function Index() {
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) {
      if (role) {
        navigate(role === 'trainer' ? '/trainer' : '/player');
      } else {
        navigate('/select-role');
      }
    }
  }, [user, role, loading, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/5">
      {/* Header */}
      <header className="container mx-auto px-4 py-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-3xl">🎾</span>
          <span className="font-bold text-2xl">PadelMatch</span>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => navigate('/auth')}>
            Sign In
          </Button>
          <Button onClick={() => navigate('/auth')}>
            Get Started
          </Button>
        </div>
      </header>

      {/* Hero Section */}
      <main className="container mx-auto px-4 py-16 md:py-24">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h1 className="text-4xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
            Find Your Perfect Padel Trainer
          </h1>
          <p className="text-xl text-muted-foreground mb-8">
            Connect with certified padel trainers across the Netherlands. 
            Book lessons that match your skill level and start improving your game today.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" className="text-lg px-8" onClick={() => navigate('/auth')}>
              Start as Player
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
            <Button size="lg" variant="outline" className="text-lg px-8" onClick={() => navigate('/auth')}>
              Join as Trainer
            </Button>
          </div>
        </div>

        {/* Features */}
        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          <div className="text-center p-6 rounded-2xl bg-card border">
            <div className="mx-auto w-14 h-14 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center mb-4">
              <Users className="h-7 w-7 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Browse Trainers</h3>
            <p className="text-muted-foreground">
              Explore verified trainers with ratings, reviews, and detailed profiles
            </p>
          </div>

          <div className="text-center p-6 rounded-2xl bg-card border">
            <div className="mx-auto w-14 h-14 rounded-full bg-orange-100 dark:bg-orange-900 flex items-center justify-center mb-4">
              <Star className="h-7 w-7 text-orange-600 dark:text-orange-400" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Skill-Based Matching</h3>
            <p className="text-muted-foreground">
              Connect your KNLTB rating and find lessons suited to your level
            </p>
          </div>

          <div className="text-center p-6 rounded-2xl bg-card border">
            <div className="mx-auto w-14 h-14 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mb-4">
              <MapPin className="h-7 w-7 text-green-600 dark:text-green-400" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Local & Flexible</h3>
            <p className="text-muted-foreground">
              Find trainers near you with flexible booking and easy payments
            </p>
          </div>
        </div>

        {/* For Trainers */}
        <div className="mt-24 text-center max-w-3xl mx-auto">
          <div className="mx-auto w-16 h-16 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center mb-6">
            <GraduationCap className="h-8 w-8 text-white" />
          </div>
          <h2 className="text-3xl font-bold mb-4">Are you a Padel Trainer?</h2>
          <p className="text-lg text-muted-foreground mb-6">
            Grow your training business with PadelMatch. Create your profile, 
            set up lessons, and reach more students across the Netherlands.
          </p>
          <Button variant="outline" size="lg" onClick={() => navigate('/auth')}>
            Start Teaching on PadelMatch
          </Button>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t mt-24">
        <div className="container mx-auto px-4 py-8 text-center text-muted-foreground">
          <p>© 2025 PadelMatch. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
