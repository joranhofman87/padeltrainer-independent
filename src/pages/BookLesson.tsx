import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ArrowLeft, Calendar, Clock, Euro, MapPin, Star, Check } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { createBooking } from '@/lib/lessons';

interface SlotWithDetails {
  id: string;
  start_time: string;
  end_time: string;
  lesson_id: string | null;
  lessons?: {
    id: string;
    title: string;
    description: string | null;
    price: number;
    duration_minutes: number;
    location: string | null;
    min_skill_rating: number | null;
    max_skill_rating: number | null;
  } | null;
}

interface TrainerWithProfile {
  id: string;
  hourly_rate: number | null;
  experience_years: number | null;
  specializations: string[] | null;
  profiles: {
    full_name: string;
    avatar_url: string | null;
    location: string | null;
    bio: string | null;
  };
}

export default function BookLesson() {
  const { trainerId } = useParams();
  const { user, profile, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [trainer, setTrainer] = useState<TrainerWithProfile | null>(null);
  const [slots, setSlots] = useState<SlotWithDetails[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithDetails | null>(null);
  const [notes, setNotes] = useState('');
  const [loadingData, setLoadingData] = useState(true);
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'player') {
        navigate('/trainer');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (trainerId) {
      fetchData();
    }
  }, [trainerId]);

  const fetchData = async () => {
    // Fetch trainer info
    const { data: trainerData } = await supabase
      .from('trainer_profiles')
      .select(`
        id,
        hourly_rate,
        experience_years,
        specializations,
        profiles(full_name, avatar_url, location, bio)
      `)
      .eq('id', trainerId)
      .single();

    if (trainerData) {
      setTrainer(trainerData as unknown as TrainerWithProfile);
    }

    // Fetch available slots
    const { data: slotsData } = await supabase
      .from('availability_slots')
      .select(`
        id,
        start_time,
        end_time,
        lesson_id,
        lessons(id, title, description, price, duration_minutes, location, min_skill_rating, max_skill_rating)
      `)
      .eq('trainer_id', trainerId)
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true });

    if (slotsData) {
      // Filter out fully booked slots
      const slotIds = slotsData.map((s) => s.id);
      const { data: bookingsData } = await supabase
        .from('bookings')
        .select('slot_id')
        .in('slot_id', slotIds)
        .in('status', ['pending', 'confirmed']);

      const bookedSlotIds = new Set(bookingsData?.map((b) => b.slot_id) || []);
      const availableSlots = slotsData.filter((s) => !bookedSlotIds.has(s.id));
      setSlots(availableSlots as SlotWithDetails[]);
    }

    setLoadingData(false);
  };

  const handleBook = async () => {
    if (!selectedSlot || !profile?.id) return;

    // Check skill rating requirements
    const lesson = selectedSlot.lessons;
    if (lesson) {
      const playerRating = profile.skill_rating;
      if (lesson.min_skill_rating && (!playerRating || playerRating < lesson.min_skill_rating)) {
        toast({
          title: 'Rating Too Low',
          description: `This lesson requires a minimum rating of ${lesson.min_skill_rating}`,
          variant: 'destructive',
        });
        return;
      }
      if (lesson.max_skill_rating && playerRating && playerRating > lesson.max_skill_rating) {
        toast({
          title: 'Rating Too High',
          description: `This lesson is for players with rating up to ${lesson.max_skill_rating}`,
          variant: 'destructive',
        });
        return;
      }
    }

    setBooking(true);

    try {
      const { error } = await createBooking(
        profile.id,
        selectedSlot.id,
        selectedSlot.lesson_id,
        notes || undefined
      );

      if (error) throw error;

      setBooked(true);
      toast({ title: 'Success', description: 'Lesson booked successfully!' });
    } catch (error: any) {
      toast({
        title: 'Booking Failed',
        description: error.message || 'Could not complete booking',
        variant: 'destructive',
      });
    } finally {
      setBooking(false);
    }
  };

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!trainer) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="p-8 text-center">
          <h2 className="text-xl font-semibold mb-2">Trainer not found</h2>
          <Button onClick={() => navigate('/trainers')}>Browse Trainers</Button>
        </Card>
      </div>
    );
  }

  if (booked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mx-auto mb-4">
            <Check className="h-8 w-8 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Booking Confirmed!</h2>
          <p className="text-muted-foreground mb-6">
            Your lesson with {trainer.profiles.full_name} has been booked.
            You'll receive a confirmation soon.
          </p>
          <div className="space-y-3">
            <Button className="w-full" onClick={() => navigate('/bookings')}>
              View My Bookings
            </Button>
            <Button variant="outline" className="w-full" onClick={() => navigate('/trainers')}>
              Book Another Lesson
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const initials = trainer.profiles.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'T';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">Book a Lesson</h1>
            <p className="text-sm text-muted-foreground">with {trainer.profiles.full_name}</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="grid lg:grid-cols-[1fr_400px] gap-8">
          {/* Trainer Info & Slots */}
          <div className="space-y-6">
            {/* Trainer Card */}
            <Card>
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={trainer.profiles.avatar_url || undefined} />
                    <AvatarFallback className="text-xl">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <h2 className="text-xl font-semibold">{trainer.profiles.full_name}</h2>
                    {trainer.profiles.location && (
                      <p className="text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-4 w-4" />
                        {trainer.profiles.location}
                      </p>
                    )}
                    {trainer.specializations && trainer.specializations.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {trainer.specializations.map((spec, i) => (
                          <span
                            key={i}
                            className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded"
                          >
                            {spec}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Available Slots */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Available Time Slots</h3>
              {slots.length === 0 ? (
                <Card className="p-8 text-center">
                  <p className="text-muted-foreground">No available slots at the moment</p>
                </Card>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {slots.map((slot) => (
                    <Card
                      key={slot.id}
                      className={`cursor-pointer transition-all ${
                        selectedSlot?.id === slot.id
                          ? 'ring-2 ring-primary border-primary'
                          : 'hover:border-primary/50'
                      }`}
                      onClick={() => setSelectedSlot(slot)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Calendar className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">
                              {format(parseISO(slot.start_time), 'EEE, MMM d')}
                            </span>
                          </div>
                          {selectedSlot?.id === slot.id && (
                            <Check className="h-5 w-5 text-primary" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                          <Clock className="h-4 w-4" />
                          {format(parseISO(slot.start_time), 'HH:mm')} -{' '}
                          {format(parseISO(slot.end_time), 'HH:mm')}
                        </div>
                        {slot.lessons && (
                          <div className="pt-2 border-t">
                            <p className="font-medium text-sm">{slot.lessons.title}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <Euro className="h-4 w-4 text-primary" />
                              <span className="font-semibold text-primary">
                                €{slot.lessons.price}
                              </span>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Booking Summary */}
          <div className="lg:sticky lg:top-24 h-fit">
            <Card>
              <CardHeader>
                <CardTitle>Booking Summary</CardTitle>
                <CardDescription>Review your lesson booking</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedSlot ? (
                  <>
                    <div className="p-4 bg-muted rounded-lg space-y-2">
                      <p className="font-semibold">
                        {selectedSlot.lessons?.title || 'Training Session'}
                      </p>
                      <div className="text-sm text-muted-foreground space-y-1">
                        <p className="flex items-center gap-2">
                          <Calendar className="h-4 w-4" />
                          {format(parseISO(selectedSlot.start_time), 'EEEE, MMMM d, yyyy')}
                        </p>
                        <p className="flex items-center gap-2">
                          <Clock className="h-4 w-4" />
                          {format(parseISO(selectedSlot.start_time), 'HH:mm')} -{' '}
                          {format(parseISO(selectedSlot.end_time), 'HH:mm')}
                        </p>
                        {selectedSlot.lessons?.location && (
                          <p className="flex items-center gap-2">
                            <MapPin className="h-4 w-4" />
                            {selectedSlot.lessons.location}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="notes">Notes for trainer (optional)</Label>
                      <Textarea
                        id="notes"
                        placeholder="Any special requests or information..."
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                      />
                    </div>

                    <div className="border-t pt-4">
                      <div className="flex justify-between items-center text-lg font-semibold">
                        <span>Total</span>
                        <span>
                          €{selectedSlot.lessons?.price || trainer.hourly_rate || 50}
                        </span>
                      </div>
                    </div>

                    <Button
                      className="w-full"
                      size="lg"
                      onClick={handleBook}
                      disabled={booking}
                    >
                      {booking ? 'Booking...' : 'Confirm Booking'}
                    </Button>
                  </>
                ) : (
                  <p className="text-muted-foreground text-center py-8">
                    Select a time slot to continue
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
