import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Calendar } from '@/components/ui/calendar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Plus, Trash2, Clock, CalendarDays } from 'lucide-react';
import { format, addHours, parseISO, isSameDay } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { createAvailabilitySlot, getTrainerAvailability, deleteAvailabilitySlot, type AvailabilitySlot, type Lesson } from '@/lib/lessons';

interface SlotWithLesson extends AvailabilitySlot {
  lessons?: Lesson | null;
}

export default function ManageAvailability() {
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotWithLesson[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());

  // Form state
  const [formData, setFormData] = useState({
    date: new Date(),
    startTime: '09:00',
    endTime: '10:00',
    lessonId: '',
  });

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (user && role === 'trainer') {
      fetchData();
    }
  }, [user, role]);

  const fetchData = async () => {
    const { data: trainerProfile } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user!.id)
      .single();

    if (trainerProfile) {
      setTrainerId(trainerProfile.id);

      // Fetch lessons
      const { data: lessonsData } = await supabase
        .from('lessons')
        .select('*')
        .eq('trainer_id', trainerProfile.id)
        .eq('is_active', true);
      
      if (lessonsData) {
        setLessons(lessonsData as Lesson[]);
      }

      // Fetch availability
      const { data: slotsData } = await getTrainerAvailability(trainerProfile.id);
      if (slotsData) {
        setSlots(slotsData as SlotWithLesson[]);
      }
    }
    setLoadingData(false);
  };

  const handleSubmit = async () => {
    if (!trainerId) return;

    const startDateTime = new Date(formData.date);
    const [startHour, startMin] = formData.startTime.split(':').map(Number);
    startDateTime.setHours(startHour, startMin, 0, 0);

    const endDateTime = new Date(formData.date);
    const [endHour, endMin] = formData.endTime.split(':').map(Number);
    endDateTime.setHours(endHour, endMin, 0, 0);

    if (endDateTime <= startDateTime) {
      toast({
        title: 'Invalid Time',
        description: 'End time must be after start time',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);

    try {
      const { error } = await createAvailabilitySlot(trainerId, {
        start_time: startDateTime.toISOString(),
        end_time: endDateTime.toISOString(),
        lesson_id: formData.lessonId || null,
        is_recurring: false,
        recurrence_rule: null,
      });

      if (error) throw error;

      toast({ title: 'Success', description: 'Availability slot created' });
      setDialogOpen(false);
      fetchData();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to create slot',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (slotId: string) => {
    if (!confirm('Delete this availability slot?')) return;

    const { error } = await deleteAvailabilitySlot(slotId);
    if (error) {
      toast({
        title: 'Error',
        description: 'Failed to delete slot',
        variant: 'destructive',
      });
    } else {
      toast({ title: 'Success', description: 'Slot deleted' });
      fetchData();
    }
  };

  const slotsForSelectedDate = slots.filter(slot =>
    selectedDate && isSameDay(parseISO(slot.start_time), selectedDate)
  );

  const datesWithSlots = slots.map(slot => parseISO(slot.start_time));

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">Manage Availability</h1>
            <p className="text-sm text-muted-foreground">Set when you're available for lessons</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="flex justify-end mb-6">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                Add Time Slot
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Add Availability</DialogTitle>
                <DialogDescription>
                  Create a time slot when you're available for lessons
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Date</Label>
                  <Calendar
                    mode="single"
                    selected={formData.date}
                    onSelect={(date) => date && setFormData({ ...formData, date })}
                    disabled={(date) => date < new Date()}
                    className="rounded-md border"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="startTime">Start Time</Label>
                    <Input
                      id="startTime"
                      type="time"
                      value={formData.startTime}
                      onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="endTime">End Time</Label>
                    <Input
                      id="endTime"
                      type="time"
                      value={formData.endTime}
                      onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="lesson">Lesson (optional)</Label>
                  <Select
                    value={formData.lessonId}
                    onValueChange={(value) => setFormData({ ...formData, lessonId: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Any lesson / custom session" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Any lesson</SelectItem>
                      {lessons.map((lesson) => (
                        <SelectItem key={lesson.id} value={lesson.id}>
                          {lesson.title} (€{lesson.price})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Link to a specific lesson type or leave empty for flexible booking
                  </p>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={saving}>
                  {saving ? 'Adding...' : 'Add Slot'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid lg:grid-cols-[350px_1fr] gap-8">
          {/* Calendar */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5" />
                Calendar
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={setSelectedDate}
                modifiers={{
                  hasSlots: datesWithSlots,
                }}
                modifiersStyles={{
                  hasSlots: { fontWeight: 'bold', textDecoration: 'underline' },
                }}
                className="rounded-md"
              />
            </CardContent>
          </Card>

          {/* Slots for selected date */}
          <div>
            <h2 className="text-lg font-semibold mb-4">
              {selectedDate ? format(selectedDate, 'EEEE, MMMM d, yyyy') : 'Select a date'}
            </h2>

            {slotsForSelectedDate.length === 0 ? (
              <Card className="p-8 text-center">
                <p className="text-muted-foreground">No availability set for this date</p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => {
                    setFormData({ ...formData, date: selectedDate || new Date() });
                    setDialogOpen(true);
                  }}
                >
                  Add availability
                </Button>
              </Card>
            ) : (
              <div className="space-y-3">
                {slotsForSelectedDate.map((slot) => (
                  <Card key={slot.id}>
                    <CardContent className="p-4 flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 text-lg font-medium">
                          <Clock className="h-5 w-5 text-muted-foreground" />
                          {format(parseISO(slot.start_time), 'HH:mm')} - {format(parseISO(slot.end_time), 'HH:mm')}
                        </div>
                        {slot.lessons && (
                          <span className="text-sm bg-primary/10 text-primary px-2 py-1 rounded">
                            {slot.lessons.title}
                          </span>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        onClick={() => handleDelete(slot.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
