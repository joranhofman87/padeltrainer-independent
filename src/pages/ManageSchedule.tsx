import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Clock, RefreshCw, CalendarDays, Settings, CalendarIcon } from 'lucide-react';
import { format, addWeeks, startOfDay, addMinutes, setHours, setMinutes, isAfter, isBefore, addDays, getDay, subWeeks } from 'date-fns';
import { cn } from '@/lib/utils';

interface WorkingHour {
  id?: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
}

interface ScheduleSettings {
  slot_duration_minutes: number;
  slot_gap_minutes: number;
  schedule_weeks_ahead: number;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TIME_OPTIONS = Array.from({ length: 24 * 2 }, (_, i) => {
  const hours = Math.floor(i / 2);
  const minutes = (i % 2) * 30;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
});

export default function ManageSchedule() {
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [workingHours, setWorkingHours] = useState<WorkingHour[]>(
    DAYS.map((_, idx) => ({
      day_of_week: idx,
      start_time: '09:00',
      end_time: '17:00',
      is_active: idx >= 1 && idx <= 5, // Mon-Fri by default
    }))
  );
  const [settings, setSettings] = useState<ScheduleSettings>({
    slot_duration_minutes: 60,
    slot_gap_minutes: 0,
    schedule_weeks_ahead: 4,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [lessons, setLessons] = useState<{ id: string; title: string }[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [cycleStartDate, setCycleStartDate] = useState<Date>(startOfDay(new Date()));

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (!role) {
        navigate('/select-role');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (user) {
      fetchData();
    }
  }, [user]);

  const fetchData = async () => {
    setDataLoading(true);
    try {
      // Get trainer profile
      const { data: trainerProfile, error: trainerError } = await supabase
        .from('trainer_profiles')
        .select('id, slot_duration_minutes, slot_gap_minutes, schedule_weeks_ahead')
        .eq('user_id', user?.id)
        .single();

      if (trainerError) throw trainerError;
      setTrainerId(trainerProfile.id);
      setSettings({
        slot_duration_minutes: trainerProfile.slot_duration_minutes,
        slot_gap_minutes: trainerProfile.slot_gap_minutes,
        schedule_weeks_ahead: trainerProfile.schedule_weeks_ahead,
      });

      // Get working hours
      const { data: hours, error: hoursError } = await supabase
        .from('trainer_working_hours')
        .select('*')
        .eq('trainer_id', trainerProfile.id);

      if (hoursError) throw hoursError;

      if (hours && hours.length > 0) {
        setWorkingHours(
          DAYS.map((_, idx) => {
            const existing = hours.find((h) => h.day_of_week === idx);
            return existing
              ? {
                  id: existing.id,
                  day_of_week: existing.day_of_week,
                  start_time: existing.start_time,
                  end_time: existing.end_time,
                  is_active: existing.is_active,
                }
              : {
                  day_of_week: idx,
                  start_time: '09:00',
                  end_time: '17:00',
                  is_active: false,
                };
          })
        );
      }

      // Get lessons for linking
      const { data: lessonData, error: lessonError } = await supabase
        .from('lessons')
        .select('id, title')
        .eq('trainer_id', trainerProfile.id)
        .eq('is_active', true);

      if (lessonError) throw lessonError;
      setLessons(lessonData || []);
    } catch (error: any) {
      toast({
        title: 'Error loading data',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setDataLoading(false);
    }
  };

  const updateDay = (dayIndex: number, updates: Partial<WorkingHour>) => {
    setWorkingHours((prev) =>
      prev.map((wh) => (wh.day_of_week === dayIndex ? { ...wh, ...updates } : wh))
    );
  };

  const saveSchedule = async () => {
    if (!trainerId) return;
    setIsSaving(true);

    try {
      // Update trainer profile settings
      const { error: settingsError } = await supabase
        .from('trainer_profiles')
        .update({
          slot_duration_minutes: settings.slot_duration_minutes,
          slot_gap_minutes: settings.slot_gap_minutes,
          schedule_weeks_ahead: settings.schedule_weeks_ahead,
        })
        .eq('id', trainerId);

      if (settingsError) throw settingsError;

      // Upsert working hours
      for (const wh of workingHours) {
        if (wh.id) {
          const { error } = await supabase
            .from('trainer_working_hours')
            .update({
              start_time: wh.start_time,
              end_time: wh.end_time,
              is_active: wh.is_active,
            })
            .eq('id', wh.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from('trainer_working_hours').insert({
            trainer_id: trainerId,
            day_of_week: wh.day_of_week,
            start_time: wh.start_time,
            end_time: wh.end_time,
            is_active: wh.is_active,
          });
          if (error) throw error;
        }
      }

      toast({ title: 'Schedule saved successfully!' });
      fetchData(); // Refresh to get IDs
    } catch (error: any) {
      toast({
        title: 'Error saving schedule',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const calculateSlotCount = () => {
    const activeDays = workingHours.filter((wh) => wh.is_active);
    let recurringSlots = 0;
    let totalSessions = 0;

    // Calculate days in the cycle period
    const today = startOfDay(new Date());
    const effectiveStart = isAfter(cycleStartDate, today) ? cycleStartDate : today;
    const endDate = addWeeks(cycleStartDate, settings.schedule_weeks_ahead);
    const weeksInCycle = settings.schedule_weeks_ahead;

    activeDays.forEach((day) => {
      const [startH, startM] = day.start_time.split(':').map(Number);
      const [endH, endM] = day.end_time.split(':').map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      const availableMinutes = endMinutes - startMinutes;
      const slotWithGap = settings.slot_duration_minutes + settings.slot_gap_minutes;
      const slotsPerDay = Math.floor(availableMinutes / slotWithGap);
      recurringSlots += slotsPerDay; // One recurring slot per time slot
      totalSessions += slotsPerDay * weeksInCycle; // Total sessions = slots × weeks
    });

    return { recurringSlots, totalSessions, weeksInCycle };
  };

  const generateSlots = async () => {
    if (!trainerId) return;
    setIsGenerating(true);

    try {
      const today = startOfDay(new Date());
      // Use cycleStartDate as the base, but skip any past slots
      const effectiveStart = isBefore(cycleStartDate, today) ? today : cycleStartDate;
      const endDate = addWeeks(cycleStartDate, settings.schedule_weeks_ahead);
      const activeDays = workingHours.filter((wh) => wh.is_active);
      const slotsToInsert: {
        trainer_id: string;
        start_time: string;
        end_time: string;
        lesson_id: string | null;
        is_recurring: boolean;
        recurrence_rule: string | null;
      }[] = [];

      // Get existing slots to avoid duplicates
      const { data: existingSlots } = await supabase
        .from('availability_slots')
        .select('start_time')
        .eq('trainer_id', trainerId)
        .gte('start_time', effectiveStart.toISOString());

      const existingTimes = new Set(existingSlots?.map((s) => s.start_time) || []);

      // Generate recurring slots - one for each time slot per active day
      // Each slot recurs weekly for the duration of the cycle
      const recurrenceCount = settings.schedule_weeks_ahead;
      const recurrenceEndDate = format(endDate, 'yyyy-MM-dd');

      // Find the first occurrence of each active day starting from cycleStartDate
      for (const dayConfig of activeDays) {
        // Find the first occurrence of this day of week on or after cycleStartDate
        let firstOccurrence = cycleStartDate;
        while (getDay(firstOccurrence) !== dayConfig.day_of_week) {
          firstOccurrence = addDays(firstOccurrence, 1);
        }

        // Skip if first occurrence is beyond the end date
        if (!isBefore(firstOccurrence, endDate)) continue;

        // Generate slots for this day
        const [startH, startM] = dayConfig.start_time.split(':').map(Number);
        const [endH, endM] = dayConfig.end_time.split(':').map(Number);

        let slotStart = setMinutes(setHours(firstOccurrence, startH), startM);
        const dayEnd = setMinutes(setHours(firstOccurrence, endH), endM);

        while (isBefore(addMinutes(slotStart, settings.slot_duration_minutes), dayEnd) || 
               addMinutes(slotStart, settings.slot_duration_minutes).getTime() === dayEnd.getTime()) {
          const slotEnd = addMinutes(slotStart, settings.slot_duration_minutes);
          
          // Check if this slot or any of its recurrences already exists
          let slotExists = false;
          let checkDate = slotStart;
          while (isBefore(checkDate, endDate)) {
            if (existingTimes.has(checkDate.toISOString())) {
              slotExists = true;
              break;
            }
            checkDate = addWeeks(checkDate, 1);
          }

          // Only add if the first occurrence is in the future and doesn't exist
          const firstSlotIsInFuture = isAfter(slotStart, new Date()) || 
            (isBefore(slotStart, new Date()) && isAfter(addWeeks(slotStart, 1), new Date()));
          
          if (!slotExists && firstSlotIsInFuture) {
            // Use the first future occurrence as the start time
            let actualStart = slotStart;
            let actualEnd = slotEnd;
            while (isBefore(actualStart, new Date()) && isBefore(actualStart, endDate)) {
              actualStart = addWeeks(actualStart, 1);
              actualEnd = addWeeks(actualEnd, 1);
            }

            if (isBefore(actualStart, endDate)) {
              // Calculate remaining weeks from actual start to end
              const weeksRemaining = Math.ceil((endDate.getTime() - actualStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
              
              slotsToInsert.push({
                trainer_id: trainerId,
                start_time: actualStart.toISOString(),
                end_time: actualEnd.toISOString(),
                lesson_id: lessonId,
                is_recurring: weeksRemaining > 1,
                recurrence_rule: weeksRemaining > 1 ? `FREQ=WEEKLY;COUNT=${weeksRemaining};UNTIL=${recurrenceEndDate}` : null,
              });
            }
          }

          slotStart = addMinutes(slotEnd, settings.slot_gap_minutes);
        }
      }

      if (slotsToInsert.length === 0) {
        toast({ title: 'No new slots to create', description: 'All slots already exist or are in the past.' });
        setIsGenerating(false);
        return;
      }

      // Batch insert
      const { error } = await supabase.from('availability_slots').insert(slotsToInsert);
      if (error) throw error;

      // Calculate total slot instances (recurring slots × weeks)
      const totalInstances = slotsToInsert.reduce((acc, slot) => {
        if (slot.is_recurring && slot.recurrence_rule) {
          const countMatch = slot.recurrence_rule.match(/COUNT=(\d+)/);
          return acc + (countMatch ? parseInt(countMatch[1]) : 1);
        }
        return acc + 1;
      }, 0);

      // Notify followers about new availability
      try {
        await supabase.functions.invoke('notify-followers', {
          body: {
            trainer_id: trainerId,
            slot_count: totalInstances,
            date_range: `${format(effectiveStart, 'MMM d')} - ${format(endDate, 'MMM d, yyyy')}`,
          },
        });
      } catch (notifyError) {
        console.log('Failed to notify followers:', notifyError);
        // Don't fail the whole operation if notifications fail
      }

      toast({
        title: 'Recurring slots generated!',
        description: `Created ${slotsToInsert.length} recurring slots (${totalInstances} total sessions over ${settings.schedule_weeks_ahead} weeks).`,
      });
    } catch (error: any) {
      toast({
        title: 'Error generating slots',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  if (loading || dataLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const estimatedSlots = calculateSlotCount();

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3">
            <CalendarDays className="h-6 w-6 text-primary" />
            <span className="font-bold text-xl">Working Hours</span>
          </div>
          <div className="ml-auto">
            <Button onClick={saveSchedule} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Schedule'}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Training Cycle Setup</h1>
          <p className="text-muted-foreground">
            Define your regular working hours and bulk generate availability slots for your training cycle.
          </p>
        </div>

        {/* Cycle Start Date */}
        <Card className="mb-6 border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarIcon className="h-5 w-5" />
              Cycle Start Date
            </CardTitle>
            <CardDescription>
              Choose when your training cycle begins. Slots will be generated from this date forward.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full sm:w-[280px] justify-start text-left font-normal",
                    !cycleStartDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {cycleStartDate ? format(cycleStartDate, "PPP") : "Pick a start date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={cycleStartDate}
                  onSelect={(date) => date && setCycleStartDate(startOfDay(date))}
                  disabled={(date) => isBefore(date, subWeeks(startOfDay(new Date()), 2))}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            <p className="text-xs text-muted-foreground mt-2">
              You can start up to 2 weeks in the past. Past slots will be skipped automatically.
            </p>
          </CardContent>
        </Card>

        {/* Weekly Schedule */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Weekly Hours
            </CardTitle>
            <CardDescription>Toggle days on/off and set your working hours</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {workingHours.map((day) => (
              <div
                key={day.day_of_week}
                className={`flex items-center gap-4 p-3 rounded-lg border ${
                  day.is_active ? 'bg-primary/5 border-primary/20' : 'bg-muted/50'
                }`}
              >
                <Switch
                  checked={day.is_active}
                  onCheckedChange={(checked) => updateDay(day.day_of_week, { is_active: checked })}
                />
                <span className="w-24 font-medium">{DAYS[day.day_of_week]}</span>
                <div className="flex items-center gap-2 flex-1">
                  <Select
                    value={day.start_time}
                    onValueChange={(value) => updateDay(day.day_of_week, { start_time: value })}
                    disabled={!day.is_active}
                  >
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIME_OPTIONS.map((time) => (
                        <SelectItem key={time} value={time}>
                          {time}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground">to</span>
                  <Select
                    value={day.end_time}
                    onValueChange={(value) => updateDay(day.day_of_week, { end_time: value })}
                    disabled={!day.is_active}
                  >
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIME_OPTIONS.map((time) => (
                        <SelectItem key={time} value={time}>
                          {time}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Settings */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Slot Settings
            </CardTitle>
            <CardDescription>Configure how slots are generated</CardDescription>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Slot Duration</label>
              <Select
                value={settings.slot_duration_minutes.toString()}
                onValueChange={(v) =>
                  setSettings((s) => ({ ...s, slot_duration_minutes: parseInt(v) }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="45">45 minutes</SelectItem>
                  <SelectItem value="60">60 minutes</SelectItem>
                  <SelectItem value="90">90 minutes</SelectItem>
                  <SelectItem value="120">120 minutes</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Break Between</label>
              <Select
                value={settings.slot_gap_minutes.toString()}
                onValueChange={(v) =>
                  setSettings((s) => ({ ...s, slot_gap_minutes: parseInt(v) }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">No break</SelectItem>
                  <SelectItem value="10">10 minutes</SelectItem>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Generate Ahead</label>
              <Select
                value={settings.schedule_weeks_ahead.toString()}
                onValueChange={(v) =>
                  setSettings((s) => ({ ...s, schedule_weeks_ahead: parseInt(v) }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">2 weeks</SelectItem>
                  <SelectItem value="4">4 weeks</SelectItem>
                  <SelectItem value="6">6 weeks</SelectItem>
                  <SelectItem value="8">8 weeks</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Lesson Link (Optional) */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Link to Lesson (Optional)</CardTitle>
            <CardDescription>
              Associate generated slots with a specific lesson for pricing and details
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select value={lessonId || 'none'} onValueChange={(v) => setLessonId(v === 'none' ? null : v)}>
              <SelectTrigger className="max-w-sm">
                <SelectValue placeholder="No lesson linked" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No lesson linked</SelectItem>
                {lessons.map((lesson) => (
                  <SelectItem key={lesson.id} value={lesson.id}>
                    {lesson.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Generate Button */}
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="font-semibold text-lg mb-1">Generate Recurring Availability Slots</h3>
                <p className="text-muted-foreground text-sm">
                  This will create <strong>{estimatedSlots.recurringSlots}</strong> recurring slots, each repeating weekly for <strong>{estimatedSlots.weeksInCycle} weeks</strong> ({estimatedSlots.totalSessions} total sessions). Existing slots won't be duplicated.
                </p>
              </div>
              <Button
                size="lg"
                onClick={generateSlots}
                disabled={isGenerating || estimatedSlots.recurringSlots === 0}
                className="gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${isGenerating ? 'animate-spin' : ''}`} />
                {isGenerating ? 'Generating...' : 'Generate Slots'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
