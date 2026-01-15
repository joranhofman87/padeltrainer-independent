import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { 
  ArrowLeft, MapPin, Star, Clock, Award, Mail, Phone, 
  Calendar, Users, CheckCircle 
} from 'lucide-react';
import { TrainerReviews } from '@/components/reviews/TrainerReviews';
import { StarRating } from '@/components/reviews/StarRating';
import { getTrainerAverageRating } from '@/lib/reviews';

interface TrainerData {
  id: string;
  user_id: string;
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
}

interface ProfileData {
  full_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
}

export default function TrainerProfile() {
  const { trainerId } = useParams<{ trainerId: string }>();
  const [trainer, setTrainer] = useState<TrainerData | null>(null);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [averageRating, setAverageRating] = useState<number | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const navigate = useNavigate();
  const { user, role } = useAuth();

  useEffect(() => {
    if (trainerId) {
      fetchTrainerProfile();
    }
  }, [trainerId]);

  const fetchTrainerProfile = async () => {
    setLoading(true);
    
    const [trainerResult, profileResult] = await Promise.all([
      supabase
        .from('trainer_profiles')
        .select('*')
        .eq('user_id', trainerId)
        .single(),
      supabase
        .from('profiles')
        .select('full_name, avatar_url, bio, location, email, phone')
        .eq('user_id', trainerId)
        .single()
    ]);

    if (trainerResult.error) {
      console.error('Error fetching trainer:', trainerResult.error);
    } else {
      setTrainer(trainerResult.data);
      // Fetch reviews for this trainer
      const ratingRes = await getTrainerAverageRating(trainerResult.data.id);
      setAverageRating(ratingRes.average);
      setReviewCount(ratingRes.count);
    }

    if (profileResult.error) {
      console.error('Error fetching profile:', profileResult.error);
    } else {
      setProfile(profileResult.data);
    }

    setLoading(false);
  };

  const getInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!trainer || !profile) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b">
          <div className="container mx-auto px-4 py-4">
            <Button variant="ghost" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </div>
        </header>
        <main className="container mx-auto px-4 py-12 text-center">
          <h1 className="text-2xl font-bold mb-2">Trainer Not Found</h1>
          <p className="text-muted-foreground mb-4">This trainer profile doesn't exist or has been removed.</p>
          <Button onClick={() => navigate('/trainers')}>Browse Trainers</Button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          {!user && (
            <Button onClick={() => navigate('/auth')}>Sign In to Book</Button>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Profile Header */}
        <Card className="mb-6">
          <CardContent className="p-6 md:p-8">
            <div className="flex flex-col md:flex-row gap-6">
              <Avatar className="h-28 w-28 mx-auto md:mx-0">
                <AvatarImage src={profile.avatar_url || undefined} />
                <AvatarFallback className="text-3xl">
                  {getInitials(profile.full_name)}
                </AvatarFallback>
              </Avatar>
              
              <div className="flex-1 text-center md:text-left">
                <div className="flex flex-col md:flex-row md:items-center gap-2 mb-2">
                  <h1 className="text-3xl font-bold">{profile.full_name || 'Trainer'}</h1>
                  {trainer.is_verified && (
                    <Badge className="w-fit mx-auto md:mx-0 bg-green-500 hover:bg-green-600">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Verified Trainer
                    </Badge>
                  )}
                </div>
                
                {profile.location && (
                  <p className="text-muted-foreground flex items-center justify-center md:justify-start gap-1 mb-4">
                    <MapPin className="h-4 w-4" />
                    {profile.location}
                  </p>
                )}

                <div className="flex flex-wrap gap-4 justify-center md:justify-start text-sm">
                  {trainer.hourly_rate && (
                    <div className="flex items-center gap-1">
                      <span className="font-bold text-xl text-primary">€{trainer.hourly_rate}</span>
                      <span className="text-muted-foreground">/hour</span>
                    </div>
                  )}
                  {trainer.experience_years && (
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      {trainer.experience_years} years experience
                    </div>
                  )}
                  {averageRating !== null && (
                    <div className="flex items-center gap-1">
                      <StarRating rating={averageRating} size="sm" />
                      <span className="text-muted-foreground">({reviewCount})</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2 min-w-[160px]">
                {user && role === 'player' && (
                  <Button size="lg" className="w-full">
                    <Calendar className="h-4 w-4 mr-2" />
                    Book Lesson
                  </Button>
                )}
                <Button variant="outline" size="lg" className="w-full">
                  <Mail className="h-4 w-4 mr-2" />
                  Contact
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid md:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="md:col-span-2 space-y-6">
            {/* About */}
            {profile.bio && (
              <Card>
                <CardHeader>
                  <CardTitle>About</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground whitespace-pre-line">{profile.bio}</p>
                </CardContent>
              </Card>
            )}

            {/* Specializations */}
            {trainer.specializations && trainer.specializations.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Star className="h-5 w-5 text-yellow-500" />
                    Specializations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {trainer.specializations.map((spec, i) => (
                      <Badge key={i} variant="secondary" className="text-sm py-1 px-3">
                        {spec}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Certifications */}
            {trainer.certifications && trainer.certifications.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Award className="h-5 w-5 text-blue-500" />
                    Certifications
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {trainer.certifications.map((cert, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-green-500" />
                        {cert}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Available Lessons Placeholder */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-primary" />
                  Available Lessons
                </CardTitle>
                <CardDescription>
                  Open spots for booking
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-center py-8 text-muted-foreground">
                  <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No lessons available yet</p>
                  <p className="text-sm">Check back soon for available training sessions</p>
                </div>
              </CardContent>
            </Card>

            {/* Reviews Section */}
            {trainer && <TrainerReviews trainerId={trainer.id} />}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Quick Stats */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quick Stats</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Students
                  </span>
                  <span className="font-semibold">0</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    Lessons Given
                  </span>
                  <span className="font-semibold">0</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Star className="h-4 w-4" />
                    Rating
                  </span>
                  <span className="font-semibold">
                    {averageRating !== null ? `${averageRating} ★` : '—'}
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Contact Card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contact Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {profile.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{profile.email}</span>
                  </div>
                )}
                {profile.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <span>{profile.phone}</span>
                  </div>
                )}
                {!profile.email && !profile.phone && (
                  <p className="text-sm text-muted-foreground">
                    Contact info not available
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
