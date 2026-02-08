import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Calendar } from '@/components/ui/calendar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, Clock, Plus, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { format, addMinutes, isBefore, startOfToday, addDays } from 'date-fns';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { createLesson } from '@/lib/lessons';
import { toast } from 'sonner';

interface OnboardingStep3LessonProps {
  onNext: () => void;
  onBack: () => void;
}

interface SlotEntry {
  id: string;
  date: Date;
  time: string;
}

export function OnboardingStep3Lesson({ onNext, onBack }: OnboardingStep3LessonProps) {
  const { user } = useAuth();
  const [trainerId, setTrainerId] = useState<string | null>(null);

  // Lesson fields
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState('60');
  const [price, setPrice] = useState('');
  const [maxParticipants, setMaxParticipants] = useState('1');
  const [paymentTiming, setPaymentTiming] = useState<'upfront' | 'after'>('after');
  const [lessonCreated, setLessonCreated] = useState(false);
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [creatingLesson, setCreatingLesson] = useState(false);

  // Slot fields
  const [slots, setSlots] = useState<SlotEntry[]>([]);
  const [slotDate, setSlotDate] = useState<Date | undefined>(undefined);
  const [slotTime, setSlotTime] = useState('09:00');
  const [addingSlot, setAddingSlot] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user.id)
        .single()
        .then(({ data }) => {
          if (data) setTrainerId(data.id);
        });
    }
  }, [user]);

  const handleCreateLesson = async () => {
    if (!trainerId || !title.trim() || !price) return;

    setCreatingLesson(true);
    try {
      const { data, error } = await createLesson(trainerId, {
        title: title.trim(),
        description: null,
        duration_minutes: parseInt(duration),
        price: parseFloat(price),
        max_participants: parseInt(maxParticipants),
        min_skill_rating: null,
        max_skill_rating: null,
        location: null,
        is_active: true,
        is_recurring: false,
        recurrence_type: null,
        recurrence_day: null,
        recurrence_time: null,
        recurrence_count: null,
        recurrence_end_date: null,
        start_date: null,
        payment_timing: paymentTiming,
      });

      if (error) throw error;

      // Side effect: set hourly_rate on trainer profile
      await supabase
        .from('trainer_profiles')
        .update({ hourly_rate: parseFloat(price) })
        .eq('id', trainerId);

      setLessonId(data.id);
      setLessonCreated(true);
      toast.success('Lesson created!');
    } catch (error: any) {
      console.error('Error creating lesson:', error);
      toast.error('Failed to create lesson');
    } finally {
      setCreatingLesson(false);
    }
  };

  const handleAddSlot = async () => {
    if (!trainerId || !lessonId || !slotDate || !slotTime) return;

    setAddingSlot(true);
    try {
      const [hours, minutes] = slotTime.split(':').map(Number);
      const startTime = new Date(slotDate);
      startTime.setHours(hours, minutes, 0, 0);
      const endTime = addMinutes(startTime, parseInt(duration));

      if (isBefore(startTime, new Date())) {
        toast.error('Cannot add slots in the past');
        setAddingSlot(false);
        return;
      }

      const { data, error } = await supabase
        .from('availability_slots')
        .insert({
          trainer_id: trainerId,
          lesson_id: lessonId,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          is_recurring: false,
        })
        .select()
        .single();

      if (error) throw error;

      setSlots((prev) => [
        ...prev,
        { id: data.id, date: startTime, time: slotTime },
      ]);
      setSlotTime('09:00');
      setSlotDate(undefined);
    } catch (error: any) {
      console.error('Error adding slot:', error);
      toast.error('Failed to add slot');
    } finally {
      setAddingSlot(false);
    }
  };

  const handleRemoveSlot = async (slotId: string) => {
    await supabase.from('availability_slots').delete().eq('id', slotId);
    setSlots((prev) => prev.filter((s) => s.id !== slotId));
  };

  const handleContinue = () => {
    onNext();
  };

  const canCreateLesson = title.trim() && price && parseFloat(price) > 0;
  const next7Days = addDays(startOfToday(), 7);

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">Create your first bookable lesson</h1>
        <p className="text-muted-foreground">Define a lesson and add time slots so players can book</p>
      </div>

      {/* Part A: Lesson Creation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            {lessonCreated ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <span className="flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">A</span>
            )}
            Lesson details
          </CardTitle>
        </CardHeader>
        <CardContent>
          {lessonCreated ? (
            <div className="flex items-center gap-3 p-3 bg-green-50 dark:bg-green-950/30 rounded-lg">
              <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
              <div>
                <p className="font-medium">{title}</p>
                <p className="text-sm text-muted-foreground">
                  {duration} min · €{price} · {maxParticipants} player{parseInt(maxParticipants) > 1 ? 's' : ''} max
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Title *</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Beginner Padel Basics"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Duration</Label>
                  <Select value={duration} onValueChange={setDuration}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">30 min</SelectItem>
                      <SelectItem value="45">45 min</SelectItem>
                      <SelectItem value="60">60 min</SelectItem>
                      <SelectItem value="90">90 min</SelectItem>
                      <SelectItem value="120">120 min</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Price (€) *</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.50"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="35"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Max participants</Label>
                  <Select value={maxParticipants} onValueChange={setMaxParticipants}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1</SelectItem>
                      <SelectItem value="2">2</SelectItem>
                      <SelectItem value="3">3</SelectItem>
                      <SelectItem value="4">4</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Payment</Label>
                  <Select value={paymentTiming} onValueChange={(v) => setPaymentTiming(v as 'upfront' | 'after')}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="upfront">Upfront</SelectItem>
                      <SelectItem value="after">After lesson</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Button
                className="w-full"
                disabled={!canCreateLesson || creatingLesson}
                onClick={handleCreateLesson}
              >
                {creatingLesson ? 'Creating...' : 'Create lesson'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Part B: Slot Creation */}
      <Card className={cn(!lessonCreated && 'opacity-50 pointer-events-none')}>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <span className="flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">B</span>
            Add time slots
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Inline slot creator */}
          <div className="flex flex-col sm:flex-row gap-3">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn('justify-start text-left flex-1', !slotDate && 'text-muted-foreground')}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {slotDate ? format(slotDate, 'EEE, MMM d') : 'Pick a date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={slotDate}
                  onSelect={setSlotDate}
                  disabled={(date) => isBefore(date, startOfToday())}
                />
              </PopoverContent>
            </Popover>

            <div className="flex items-center gap-2 flex-1">
              <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                type="time"
                value={slotTime}
                onChange={(e) => setSlotTime(e.target.value)}
                className="flex-1"
              />
            </div>

            <Button
              onClick={handleAddSlot}
              disabled={!slotDate || !slotTime || addingSlot}
              size="icon"
              className="shrink-0"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          {/* Added slots */}
          {slots.length > 0 && (
            <div className="space-y-2">
              {slots.map((slot) => (
                <div key={slot.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2">
                    <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{format(slot.date, 'EEE, MMM d')}</span>
                    <span className="text-sm text-muted-foreground">at {slot.time}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => handleRemoveSlot(slot.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Badge variant={slots.length >= 2 ? 'default' : 'secondary'}>
                  {slots.length} slot{slots.length !== 1 ? 's' : ''} added
                </Badge>
              </div>
            </div>
          )}

          {/* Warning if < 2 slots */}
          {lessonCreated && slots.length < 2 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Add at least 2 time slots so players can request a booking.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-3">
        <Button variant="outline" size="lg" onClick={onBack} className="flex-1">
          Back
        </Button>
        <Button
          size="lg"
          className="flex-1"
          disabled={!lessonCreated || saving}
          onClick={handleContinue}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
