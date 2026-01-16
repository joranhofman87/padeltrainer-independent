import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Clock, RefreshCw, CalendarDays, Settings, CalendarIcon, Plus, Repeat } from 'lucide-react';
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

interface BulkSlotConfig {
  startDate: Date;
  startTime: string;
  durationMinutes: number;
  recurrenceWeeks: number;
  lessonId: string | null;
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
  const [lessons, setLessons] = useState<{ id: string; title: string }[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  // Bulk slot creation state
  const [bulkSlots, setBulkSlots] = useState<BulkSlotConfig[]>([]);

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

  // Add new bulk slot config
  const addBulkSlotConfig = () => {
    const nextMonday = getNextDayOfWeek(new Date(), 1); // 1 = Monday
    setBulkSlots([
      ...bulkSlots,
      {
        startDate: nextMonday,
        startTime: '09:00',
        durationMinutes: settings.slot_duration_minutes,
        recurrenceWeeks: settings.schedule_weeks_ahead,
        lessonId: null,
      },
    ]);
  };

  // Helper to get next occurrence of a day
  const getNextDayOfWeek = (date: Date, dayOfWeek: number) => {
    const result = new Date(date);
    result.setDate(result.getDate() + ((dayOfWeek - result.getDay() + 7) % 7 || 7));
    return startOfDay(result);
  };

  const updateBulkSlot = (index: number, updates: Partial<BulkSlotConfig>) => {
    setBulkSlots((prev) =>
      prev.map((slot, i) => (i === index ? { ...slot, ...updates } : slot))
    );
  };

  const removeBulkSlot = (index: number) => {
    setBulkSlots((prev) => prev.filter((_, i) => i !== index));
  };

  const generateBulkSlots = async () => {
    if (!trainerId || bulkSlots.length === 0) return;
    setIsGenerating(true);

    try {
      const today = startOfDay(new Date());
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
        .gte('start_time', today.toISOString());

      const existingTimes = new Set(existingSlots?.map((s) => s.start_time) || []);

      for (const config of bulkSlots) {
        const [startH, startM] = config.startTime.split(':').map(Number);
        let slotStart = setMinutes(setHours(config.startDate, startH), startM);
        const slotEnd = addMinutes(slotStart, config.durationMinutes);

        // Skip if in the past
        if (isBefore(slotStart, today)) {
          // Find first future occurrence
          const weeksToAdd = Math.ceil((today.getTime() - slotStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
          slotStart = addWeeks(slotStart, weeksToAdd);
        }

        const endDate = addWeeks(config.startDate, config.recurrenceWeeks);
        
        // Check if already exists
        if (existingTimes.has(slotStart.toISOString())) {
          continue;
        }

        const weeksRemaining = Math.max(1, Math.ceil((endDate.getTime() - slotStart.getTime()) / (7 * 24 * 60 * 60 * 1000)));
        const recurrenceEndDate = format(endDate, 'yyyy-MM-dd');

        slotsToInsert.push({
          trainer_id: trainerId,
          start_time: slotStart.toISOString(),
          end_time: addMinutes(slotStart, config.durationMinutes).toISOString(),
          lesson_id: config.lessonId,
          is_recurring: weeksRemaining > 1,
          recurrence_rule: weeksRemaining > 1 ? `FREQ=WEEKLY;COUNT=${weeksRemaining};UNTIL=${recurrenceEndDate}` : null,
        });
      }

      if (slotsToInsert.length === 0) {
        toast({ title: 'No new slots to create', description: 'All slots already exist or are in the past.' });
        setIsGenerating(false);
        return;
      }

      // Batch insert
      const { error } = await supabase.from('availability_slots').insert(slotsToInsert);
      if (error) throw error;

      // Calculate total slot instances
      const totalInstances = slotsToInsert.reduce((acc, slot) => {
        if (slot.is_recurring && slot.recurrence_rule) {
          const countMatch = slot.recurrence_rule.match(/COUNT=(\d+)/);
          return acc + (countMatch ? parseInt(countMatch[1]) : 1);
        }
        return acc + 1;
      }, 0);

      // Notify followers
      try {
        const earliestStart = new Date(Math.min(...slotsToInsert.map(s => new Date(s.start_time).getTime())));
        const latestEnd = new Date(Math.max(...bulkSlots.map(c => addWeeks(c.startDate, c.recurrenceWeeks).getTime())));
        
        await supabase.functions.invoke('notify-followers', {
          body: {
            trainer_id: trainerId,
            slot_count: totalInstances,
            date_range: `${format(earliestStart, 'MMM d')} - ${format(latestEnd, 'MMM d, yyyy')}`,
          },
        });
      } catch (notifyError) {
        console.log('Failed to notify followers:', notifyError);
      }

      toast({
        title: 'Slots generated!',
        description: `Created ${slotsToInsert.length} recurring slots (${totalInstances} total sessions).`,
      });

      // Clear the bulk slots after successful creation
      setBulkSlots([]);
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

  const totalBulkSessions = bulkSlots.reduce((acc, slot) => acc + slot.recurrenceWeeks, 0);

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
            <span className="font-bold text-xl">Training Schedule</span>
          </div>
          <div className="ml-auto">
            <Button onClick={saveSchedule} disabled={isSaving} variant="outline">
              {isSaving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Training Cycle Setup</h1>
          <p className="text-muted-foreground">
            Create recurring training slots by adding time slots and specifying how many weeks they should repeat.
          </p>
        </div>

        {/* Bulk Slot Creation */}
        <Card className="mb-6 border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Repeat className="h-5 w-5" />
              Create Recurring Slots
            </CardTitle>
            <CardDescription>
              Add training slots with a start date, time, and number of weeks to repeat
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {bulkSlots.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <CalendarDays className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="mb-4">No slots configured yet. Add your first recurring slot to get started.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {bulkSlots.map((slot, index) => (
                  <div key={index} className="p-4 border rounded-lg bg-muted/30 space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">Slot {index + 1}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeBulkSlot(index)}
                        className="text-destructive hover:text-destructive"
                      >
                        Remove
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      {/* Start Date */}
                      <div className="space-y-2">
                        <Label>Start Date</Label>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              className={cn(
                                "w-full justify-start text-left font-normal",
                                !slot.startDate && "text-muted-foreground"
                              )}
                            >
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {slot.startDate ? format(slot.startDate, "MMM d, yyyy") : "Pick date"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar
                              mode="single"
                              selected={slot.startDate}
                              onSelect={(date) => date && updateBulkSlot(index, { startDate: startOfDay(date) })}
                              disabled={(date) => isBefore(date, startOfDay(new Date()))}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                      </div>

                      {/* Start Time */}
                      <div className="space-y-2">
                        <Label>Time</Label>
                        <Select
                          value={slot.startTime}
                          onValueChange={(value) => updateBulkSlot(index, { startTime: value })}
                        >
                          <SelectTrigger>
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

                      {/* Duration */}
                      <div className="space-y-2">
                        <Label>Duration</Label>
                        <Select
                          value={slot.durationMinutes.toString()}
                          onValueChange={(value) => updateBulkSlot(index, { durationMinutes: parseInt(value) })}
                        >
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

                      {/* Recurrence Weeks */}
                      <div className="space-y-2">
                        <Label>Repeat for</Label>
                        <Select
                          value={slot.recurrenceWeeks.toString()}
                          onValueChange={(value) => updateBulkSlot(index, { recurrenceWeeks: parseInt(value) })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[1, 2, 4, 6, 8, 10, 12].map((weeks) => (
                              <SelectItem key={weeks} value={weeks.toString()}>
                                {weeks} week{weeks !== 1 ? 's' : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {/* Lesson Link */}
                    <div className="space-y-2">
                      <Label>Link to Lesson (Optional)</Label>
                      <Select 
                        value={slot.lessonId || 'none'} 
                        onValueChange={(v) => updateBulkSlot(index, { lessonId: v === 'none' ? null : v })}
                      >
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
                    </div>

                    {/* Summary */}
                    <p className="text-sm text-muted-foreground">
                      This will create <strong>{slot.recurrenceWeeks}</strong> sessions every{' '}
                      <strong>{format(slot.startDate, 'EEEE')}</strong> at <strong>{slot.startTime}</strong>,
                      from <strong>{format(slot.startDate, 'MMM d')}</strong> to{' '}
                      <strong>{format(addWeeks(slot.startDate, slot.recurrenceWeeks - 1), 'MMM d, yyyy')}</strong>.
                    </p>
                  </div>
                ))}
              </div>
            )}

            <Button onClick={addBulkSlotConfig} variant="outline" className="w-full gap-2">
              <Plus className="h-4 w-4" />
              Add Recurring Slot
            </Button>
          </CardContent>
        </Card>

        {/* Generate Button */}
        {bulkSlots.length > 0 && (
          <Card className="mb-6 border-primary/30 bg-primary/5">
            <CardContent className="p-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-lg mb-1">Generate Training Cycle</h3>
                  <p className="text-muted-foreground text-sm">
                    This will create <strong>{bulkSlots.length}</strong> recurring slot{bulkSlots.length !== 1 ? 's' : ''} with{' '}
                    <strong>{totalBulkSessions}</strong> total sessions. Existing slots won't be duplicated.
                  </p>
                </div>
                <Button
                  size="lg"
                  onClick={generateBulkSlots}
                  disabled={isGenerating || bulkSlots.length === 0}
                  className="gap-2"
                >
                  <RefreshCw className={`h-4 w-4 ${isGenerating ? 'animate-spin' : ''}`} />
                  {isGenerating ? 'Generating...' : 'Generate Slots'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Divider */}
        <div className="relative my-8">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">Default Settings</span>
          </div>
        </div>

        {/* Settings */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Default Slot Settings
            </CardTitle>
            <CardDescription>These defaults will be used when adding new slots</CardDescription>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Default Duration</label>
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
              <label className="text-sm font-medium mb-2 block">Default Weeks</label>
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
                  <SelectItem value="10">10 weeks</SelectItem>
                  <SelectItem value="12">12 weeks</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Working Hours Reference */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Weekly Hours Reference
            </CardTitle>
            <CardDescription>Your general working hours (for reference when adding slots)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {workingHours.map((day) => (
              <div
                key={day.day_of_week}
                className={`flex items-center gap-4 p-2 rounded-lg ${
                  day.is_active ? 'bg-primary/5' : 'opacity-50'
                }`}
              >
                <Switch
                  checked={day.is_active}
                  onCheckedChange={(checked) => updateDay(day.day_of_week, { is_active: checked })}
                />
                <span className="w-24 font-medium text-sm">{DAYS[day.day_of_week]}</span>
                <div className="flex items-center gap-2 flex-1">
                  <Select
                    value={day.start_time}
                    onValueChange={(value) => updateDay(day.day_of_week, { start_time: value })}
                    disabled={!day.is_active}
                  >
                    <SelectTrigger className="w-20 h-8 text-sm">
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
                  <span className="text-muted-foreground text-sm">-</span>
                  <Select
                    value={day.end_time}
                    onValueChange={(value) => updateDay(day.day_of_week, { end_time: value })}
                    disabled={!day.is_active}
                  >
                    <SelectTrigger className="w-20 h-8 text-sm">
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
      </main>
    </div>
  );
}
