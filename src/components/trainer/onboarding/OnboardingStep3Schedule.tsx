import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { TimeSelect } from '@/components/ui/time-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { logger } from '@/lib/logger';
import { CalendarIcon, Clock, Plus, Trash2, AlertTriangle, CheckCircle2, CalendarPlus, Repeat } from 'lucide-react';
import { format, addMinutes, isBefore, startOfToday, startOfDay, addWeeks, setHours, setMinutes } from 'date-fns';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { applySlotDeleteToCycle } from '@/lib/slotDeleteGuard';
import { createCycle } from '@/lib/cycles';
import { expandWeeklySessions, insertAvailabilitySlots } from '@/lib/slots';
import { isTrainerSlotOverlapError } from '@/lib/slotConflicts';

import { toast } from 'sonner';

interface OnboardingStep3ScheduleProps {
  onNext: () => void;
  onBack: () => void;
}

interface SlotEntry {
  id: string;
  date: Date;
  time: string;
}

type SlotMode = null | 'single' | 'cyclus';

export function OnboardingStep3Schedule({ onNext, onBack }: OnboardingStep3ScheduleProps) {
  const { user } = useAuth();
  const [trainerId, setTrainerId] = useState<string | null>(null);

  // Training session fields
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState('60');
  const [price, setPrice] = useState('');
  const [maxParticipants, setMaxParticipants] = useState('1');
  const [paymentTiming, setPaymentTiming] = useState<'upfront' | 'after'>('after');
  const [sessionCreated, setSessionCreated] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);

  // Slot mode choice
  const [slotMode, setSlotMode] = useState<SlotMode>(null);

  // Single slot fields
  const [slots, setSlots] = useState<SlotEntry[]>([]);
  const [slotDate, setSlotDate] = useState<Date | undefined>(undefined);
  const [slotTime, setSlotTime] = useState('09:00');
  const [addingSlot, setAddingSlot] = useState(false);

  // Cyclus fields
  const [cyclusDate, setCyclusDate] = useState<Date | undefined>(undefined);
  const [cyclusTime, setCyclusTime] = useState('09:00');
  const [cyclusWeeks, setCyclusWeeks] = useState('8');
  const [cyclusName, setCyclusName] = useState('');
  const [cyclusCreated, setCyclusCreated] = useState(false);
  const [cyclusSessions, setCyclusSessions] = useState(0);
  const [creatingCyclus, setCreatingCyclus] = useState(false);

  const [saving] = useState(false);

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

  const handleCreateSession = async () => {
    if (!trainerId || !title.trim() || !price) return;

    setCreatingSession(true);
    try {
      await supabase
        .from('trainer_profiles')
        .update({ hourly_rate: parseFloat(price) })
        .eq('id', trainerId);

      setSessionId(trainerId);
      setSessionCreated(true);
      toast.success('Training session settings saved!');
    } catch (error: any) {
      logger.error('Error saving session settings', error instanceof Error ? error : new Error(String(error)), { component: 'OnboardingStep3Schedule' });
      toast.error('Failed to save training session settings');
    } finally {
      setCreatingSession(false);
    }
  };

  // --- Single slot handlers ---
  const handleAddSlot = async () => {
    if (!trainerId || !sessionId || !slotDate || !slotTime) return;

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

      const slotPrice = Math.round(parseFloat(price) * (parseInt(duration) / 60) * 100) / 100;

      const { data, error } = await insertAvailabilitySlots({
        trainer_id: trainerId,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        is_recurring: false,
        max_participants: parseInt(maxParticipants),
        price_per_session: slotPrice,
      }, supabase, '*');

      if (error) throw error;

      const inserted = (data as { id: string }[])[0];
      setSlots((prev) => [
        ...prev,
        { id: inserted.id, date: startTime, time: slotTime },
      ]);
      setSlotTime('09:00');
      setSlotDate(undefined);
    } catch (error: any) {
      logger.error('Error adding slot', error instanceof Error ? error : new Error(String(error)), { component: 'OnboardingStep3Schedule' });
      toast.error(
        isTrainerSlotOverlapError(error)
          ? 'You already have a session overlapping this time.'
          : 'Failed to add slot',
      );
    } finally {
      setAddingSlot(false);
    }
  };

  const handleRemoveSlot = async (slotId: string) => {
    // Atomic + guarded delete (keeps the slot if it somehow holds a booking) rather than a bare
    // cascade delete; onboarding slots are drafts, so this is defence-in-depth + consistency.
    await applySlotDeleteToCycle(null, [slotId]);
    setSlots((prev) => prev.filter((s) => s.id !== slotId));
  };

  // --- Cyclus handler ---
  const handleCreateCyclus = async () => {
    if (!trainerId || !sessionId || !cyclusDate || !cyclusTime) return;

    setCreatingCyclus(true);
    // REBOOK-01: track the cycles row created in this run, so a failed slot
    // insert can clean it up again (no empty cyclus without slots).
    let createdCycleId: string | null = null;
    try {
      const weeks = parseInt(cyclusWeeks);
      const [startH, startM] = cyclusTime.split(':').map(Number);
      const durationMin = parseInt(duration);
      const dayName = format(cyclusDate, 'EEEE');
      const name = cyclusName.trim() || `${title} - ${dayName} ${cyclusTime}`;

      const slotsToInsert = [];
      const baseStart = setMinutes(setHours(startOfDay(cyclusDate), startH), startM);
      const slotPrice = Math.round(parseFloat(price) * (durationMin / 60) * 100) / 100;

      // REBOOK-01: create a real cycles row FIRST so this cyclus is visible to
      // the rebooking wizard and registrations list (both read from the cycles
      // table); its id becomes the slots' cyclus_id. status 'closed' so it
      // never renders as an open public registration form.
      const cycle = await createCycle({
        owner_type: 'trainer',
        owner_id: trainerId,
        name,
        start_date: format(baseStart, 'yyyy-MM-dd'),
        end_date: format(addWeeks(baseStart, weeks - 1), 'yyyy-MM-dd'),
        type: 'cyclus',
        status: 'closed',
        price_per_session: slotPrice,
        total_price: Math.round(slotPrice * weeks * 100) / 100,
        settings: {},
      });
      createdCycleId = cycle.id;
      const cyclusId = cycle.id;

      for (const session of expandWeeklySessions(baseStart, durationMin, weeks)) {
        slotsToInsert.push({
          trainer_id: trainerId,
          start_time: session.start.toISOString(),
          end_time: session.end.toISOString(),
          is_recurring: false,
          cyclus_id: cyclusId,
          cyclus_name: name,
          max_participants: parseInt(maxParticipants),
          price_per_session: slotPrice,
        });
      }

      const { error } = await insertAvailabilitySlots(slotsToInsert);

      if (error) throw error;

      setCyclusCreated(true);
      setCyclusSessions(slotsToInsert.length);
      toast.success(`Training cycle created with ${slotsToInsert.length} sessions!`);
    } catch (error: any) {
      // Best-effort cleanup: the slot insert failed, so remove the cycles row
      // again instead of leaving an empty cyclus behind.
      if (createdCycleId) {
        await supabase.from('cycles').delete().eq('id', createdCycleId);
      }
      logger.error('Error creating cyclus', error instanceof Error ? error : new Error(String(error)), { component: 'OnboardingStep3Schedule' });
      toast.error(
        isTrainerSlotOverlapError(error)
          ? 'You already have a session overlapping one of these times.'
          : 'Failed to create training cycle',
      );
    } finally {
      setCreatingCyclus(false);
    }
  };

  const handleContinue = () => {
    onNext();
  };

  const canCreateSession = title.trim() && price && parseFloat(price) > 0;
  const hasSlots = slotMode === 'single' ? slots.length > 0 : cyclusCreated;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">Set up your first training session</h1>
        <p className="text-muted-foreground">Define your rate and add time slots so players can book</p>
      </div>

      {/* Part A: Lesson Creation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            {sessionCreated ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <span className="flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">A</span>
            )}
            Session details
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sessionCreated ? (
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
                disabled={!canCreateSession || creatingSession}
                onClick={handleCreateSession}
              >
                {creatingSession ? 'Saving...' : 'Save session settings'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Part B: Slot Type Choice + Creation */}
      <Card className={cn(!sessionCreated && 'opacity-50 pointer-events-none')}>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            {hasSlots ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <span className="flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">B</span>
            )}
            Add availability
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Mode choice */}
          {!slotMode && !hasSlots && (
            <div className="grid grid-cols-2 gap-4">
              <Button
                variant="outline"
                aria-label="Single Slots"
                className="h-28 flex flex-col items-center justify-center gap-2 hover:border-primary hover:bg-primary/5"
                onClick={() => setSlotMode('single')}
              >
                <CalendarPlus className="h-7 w-7 text-primary" />
                <div className="text-center">
                  <div className="font-medium text-sm">Single Slots</div>
                  <div className="text-xs text-muted-foreground mt-0.5">One-time availability</div>
                </div>
              </Button>
              <Button
                variant="outline"
                aria-label="Training Cycle"
                className="h-28 flex flex-col items-center justify-center gap-2 hover:border-primary hover:bg-primary/5"
                onClick={() => setSlotMode('cyclus')}
              >
                <Repeat className="h-7 w-7 text-primary" />
                <div className="text-center">
                  <div className="font-medium text-sm">Training Cycle</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Weekly recurring sessions</div>
                </div>
              </Button>
            </div>
          )}

          {/* Single slot creator */}
          {slotMode === 'single' && (
            <>
              <div className="flex flex-col sm:flex-row gap-3">
                <DatePickerPopover
                  value={slotDate}
                  onChange={setSlotDate}
                  disabled={(date) => isBefore(date, startOfToday())}
                  className="flex-1"
                />

                <div className="flex items-center gap-2 flex-1">
                  <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                  <TimeSelect
                    value={slotTime}
                    onValueChange={setSlotTime}
                    triggerClassName="flex-1"
                  />
                </div>

                <Button
                  onClick={handleAddSlot}
                  disabled={!slotDate || !slotTime || addingSlot}
                  size="icon" aria-label="Add"
                  className="shrink-0"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

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
                        size="icon" aria-label="Delete"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveSlot(slot.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Badge variant={slots.length >= 2 ? 'default' : 'secondary'}>
                    {slots.length} slot{slots.length !== 1 ? 's' : ''} added
                  </Badge>
                </div>
              )}

              {slots.length < 2 && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Add at least 2 time slots so players can request a booking.
                  </AlertDescription>
                </Alert>
              )}

              <Button variant="ghost" size="sm" onClick={() => setSlotMode(null)} className="text-muted-foreground">
                ← Switch to training cycle
              </Button>
            </>
          )}

          {/* Cyclus creator */}
          {slotMode === 'cyclus' && !cyclusCreated && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Cycle name (optional)</Label>
                <Input
                  value={cyclusName}
                  onChange={(e) => setCyclusName(e.target.value)}
                  placeholder={`e.g. ${title} - Monday 09:00`}
                />
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <DatePickerPopover
                  value={cyclusDate}
                  onChange={setCyclusDate}
                  placeholder="Pick start day"
                  disabled={(date) => isBefore(date, startOfToday())}
                  className="flex-1"
                />

                <div className="flex items-center gap-2 flex-1">
                  <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                  <TimeSelect
                    value={cyclusTime}
                    onValueChange={setCyclusTime}
                    triggerClassName="flex-1"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Number of weeks</Label>
                <Select value={cyclusWeeks} onValueChange={setCyclusWeeks}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[4, 6, 8, 10, 12, 16, 20, 24].map((w) => (
                      <SelectItem key={w} value={w.toString()}>
                        {w} weeks ({w} sessions)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {cyclusDate && (
                <div className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
                  <Repeat className="h-4 w-4 inline mr-1.5" />
                  Every <strong>{format(cyclusDate, 'EEEE')}</strong> at <strong>{cyclusTime}</strong> for <strong>{cyclusWeeks} weeks</strong> ({duration} min each)
                </div>
              )}

              <Button
                className="w-full"
                disabled={!cyclusDate || !cyclusTime || creatingCyclus}
                onClick={handleCreateCyclus}
              >
                {creatingCyclus ? 'Creating...' : `Create cycle (${cyclusWeeks} sessions)`}
              </Button>

              <Button variant="ghost" size="sm" onClick={() => setSlotMode(null)} className="text-muted-foreground">
                ← Switch to single slots
              </Button>
            </div>
          )}

          {/* Cyclus created confirmation */}
          {slotMode === 'cyclus' && cyclusCreated && (
            <div className="flex items-center gap-3 p-3 bg-green-50 dark:bg-green-950/30 rounded-lg">
              <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
              <div>
                <p className="font-medium">Training cycle created</p>
                <p className="text-sm text-muted-foreground">
                  {cyclusSessions} weekly sessions added to your calendar
                </p>
              </div>
            </div>
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
          disabled={!sessionCreated || saving}
          onClick={handleContinue}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
