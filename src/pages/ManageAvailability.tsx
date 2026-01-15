import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
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
import { ArrowLeft, Plus, Trash2, Clock, CalendarDays, Repeat, Wand2 } from 'lucide-react';
import { format, addHours, parseISO, isSameDay, addDays, addWeeks, addMonths, setDay, setDate } from 'date-fns';
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
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());

  // Form state
  const [formData, setFormData] = useState({
    date: new Date(),
    startTime: '09:00',
    endTime: '10:00',
    lessonId: '',
  });

  // Get recurring lessons
  const recurringLessons = lessons.filter(l => l.is_recurring);

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

  // Generate slots from recurring lessons
  const handleGenerateSlots = async (lessonId: string) => {
    if (!trainerId) return;
    
    const lesson = recurringLessons.find(l => l.id === lessonId);
    if (!lesson || !lesson.recurrence_time || !lesson.recurrence_count) {
      toast({ title: 'Error', description: 'Invalid recurring lesson configuration', variant: 'destructive' });
      return;
    }

    setGenerating(true);
    
    try {
      const slotsToCreate: Array<{ start_time: string; end_time: string; lesson_id: string }> = [];
      let currentDate = new Date();
      const [hours, minutes] = lesson.recurrence_time.split(':').map(Number);
      const duration = lesson.duration_minutes;
      
      for (let i = 0; i < lesson.recurrence_count; i++) {
        let slotDate: Date;
        
        if (lesson.recurrence_type === 'daily') {
          slotDate = addDays(currentDate, i);
        } else if (lesson.recurrence_type === 'weekly') {
          // Find the next occurrence of the specified day
          const targetDay = lesson.recurrence_day || 0;
          slotDate = addWeeks(setDay(currentDate, targetDay, { weekStartsOn: 0 }), i);
          if (slotDate < currentDate) {
            slotDate = addWeeks(slotDate, 1);
          }
        } else if (lesson.recurrence_type === 'monthly') {
          const targetDate = lesson.recurrence_day || 1;
          slotDate = addMonths(setDate(currentDate, targetDate), i);
          if (slotDate < currentDate) {
            slotDate = addMonths(slotDate, 1);
          }
        } else {
          continue;
        }

        // Set the time
        slotDate.setHours(hours, minutes, 0, 0);
        
        // Check if slot is in the future and before end date
        if (slotDate > new Date()) {
          if (lesson.recurrence_end_date && slotDate > new Date(lesson.recurrence_end_date)) {
            break;
          }
          
          const endDate = new Date(slotDate);
          endDate.setMinutes(endDate.getMinutes() + duration);
          
          slotsToCreate.push({
            start_time: slotDate.toISOString(),
            end_time: endDate.toISOString(),
            lesson_id: lesson.id,
          });
        }
      }

      if (slotsToCreate.length === 0) {
        toast({ title: 'No slots to create', description: 'All dates are in the past', variant: 'destructive' });
        return;
      }

      // Create all slots
      const { error } = await supabase
        .from('availability_slots')
        .insert(slotsToCreate.map(slot => ({
          trainer_id: trainerId,
          ...slot,
          is_recurring: true,
          recurrence_rule: `${lesson.recurrence_type}:${lesson.id}`,
        })));

      if (error) throw error;

      toast({ 
        title: 'Slots Generated!', 
        description: `Created ${slotsToCreate.length} availability slots for "${lesson.title}"` 
      });
      setGenerateDialogOpen(false);
      fetchData();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message || 'Failed to generate slots', variant: 'destructive' });
    } finally {
      setGenerating(false);
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
        {/* Generate from Recurring Lessons */}
        {recurringLessons.length > 0 && (
          <Card className="mb-6 border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20">
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Wand2 className="h-5 w-5 text-blue-600" />
                  <div>
                    <p className="font-medium">Auto-generate from Recurring Lessons</p>
                    <p className="text-sm text-muted-foreground">Create time slots automatically from your recurring lesson schedules</p>
                  </div>
                </div>
                <Dialog open={generateDialogOpen} onOpenChange={setGenerateDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" className="gap-2">
                      <Repeat className="h-4 w-4" />
                      Generate Slots
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Generate Recurring Slots</DialogTitle>
                      <DialogDescription>
                        Select a recurring lesson to automatically create availability slots
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      {recurringLessons.map(lesson => (
                        <Card key={lesson.id} className="cursor-pointer hover:border-primary" onClick={() => handleGenerateSlots(lesson.id)}>
                          <CardContent className="p-4">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-medium">{lesson.title}</p>
                                <p className="text-sm text-muted-foreground">
                                  {lesson.recurrence_type === 'weekly' && `Every ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][lesson.recurrence_day || 0]}`}
                                  {lesson.recurrence_type === 'daily' && 'Daily'}
                                  {lesson.recurrence_type === 'monthly' && `Day ${lesson.recurrence_day} of each month`}
                                  {' at '}{lesson.recurrence_time} • {lesson.recurrence_count} sessions
                                </p>
                              </div>
                              <Badge variant="outline">€{lesson.price}</Badge>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                    {generating && <p className="text-center text-muted-foreground">Generating slots...</p>}
                  </DialogContent>
                </Dialog>
              </div>
            </CardContent>
          </Card>
        )}

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
