import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

// Generate time options from 06:00 to 00:00 (midnight) in 30-minute increments
const TIME_OPTIONS: string[] = [];
for (let hour = 6; hour <= 23; hour++) {
  TIME_OPTIONS.push(`${hour.toString().padStart(2, '0')}:00`);
  TIME_OPTIONS.push(`${hour.toString().padStart(2, '0')}:30`);
}
// Add midnight as end time option
TIME_OPTIONS.push('00:00');

export interface TimeBlock {
  start: string;
  end: string;
}

export interface DayAvailability {
  [day: string]: TimeBlock[];
}

interface DayAvailabilityPickerProps {
  value: DayAvailability;
  onChange: (value: DayAvailability) => void;
  disabled?: boolean;
  /** When provided, only show these days and constrain time ranges */
  allowedDays?: DayAvailability;
}

// Get the overall allowed time range for a day (earliest start, latest end)
function getTimeRange(day: string, allowedDays?: DayAvailability): { start: string; end: string } | null {
  if (!allowedDays || !allowedDays[day] || allowedDays[day].length === 0) return null;
  const blocks = allowedDays[day];
  let earliest = blocks[0].start;
  let latest = blocks[0].end;
  for (const b of blocks) {
    if (TIME_OPTIONS.indexOf(b.start) < TIME_OPTIONS.indexOf(earliest)) earliest = b.start;
    if (TIME_OPTIONS.indexOf(b.end) > TIME_OPTIONS.indexOf(latest)) latest = b.end;
  }
  return { start: earliest, end: latest };
}

export default function DayAvailabilityPicker({
  value,
  onChange,
  disabled = false,
  allowedDays,
}: DayAvailabilityPickerProps) {
  const { t } = useTranslation('cycles');

  const isDayEnabled = (day: string) => {
    return value[day] && value[day].length > 0;
  };

  const toggleDay = (day: string) => {
    if (isDayEnabled(day)) {
      const newValue = { ...value };
      delete newValue[day];
      onChange(newValue);
    } else {
      // Use allowed blocks if available, otherwise default
      const defaultBlocks = allowedDays?.[day]
        ? allowedDays[day].map(b => ({ ...b }))
        : [{ start: '09:00', end: '17:00' }];
      onChange({ ...value, [day]: defaultBlocks });
    }
  };

  const updateTimeBlock = (day: string, index: number, field: 'start' | 'end', newTime: string) => {
    const dayBlocks = [...(value[day] || [])];
    dayBlocks[index] = { ...dayBlocks[index], [field]: newTime };
    onChange({ ...value, [day]: dayBlocks });
  };

  const addTimeBlock = (day: string) => {
    const dayBlocks = [...(value[day] || [])];
    const range = getTimeRange(day, allowedDays);
    const lastBlock = dayBlocks[dayBlocks.length - 1];
    let defaultStart = '18:00';
    let defaultEnd = '21:00';

    if (lastBlock) {
      const lastEndIndex = TIME_OPTIONS.indexOf(lastBlock.end);
      if (lastEndIndex >= 0 && lastEndIndex < TIME_OPTIONS.length - 2) {
        defaultStart = TIME_OPTIONS[lastEndIndex];
        defaultEnd = TIME_OPTIONS[Math.min(lastEndIndex + 4, TIME_OPTIONS.length - 1)];
      }
    }

    // Clamp to allowed range
    if (range) {
      const ri = TIME_OPTIONS.indexOf(range.start);
      const re = TIME_OPTIONS.indexOf(range.end);
      if (TIME_OPTIONS.indexOf(defaultStart) < ri) defaultStart = range.start;
      if (TIME_OPTIONS.indexOf(defaultEnd) > re) defaultEnd = range.end;
      if (TIME_OPTIONS.indexOf(defaultStart) >= re) return; // no room
      if (TIME_OPTIONS.indexOf(defaultEnd) <= TIME_OPTIONS.indexOf(defaultStart)) {
        defaultEnd = TIME_OPTIONS[Math.min(TIME_OPTIONS.indexOf(defaultStart) + 2, re)];
      }
    }

    dayBlocks.push({ start: defaultStart, end: defaultEnd });
    onChange({ ...value, [day]: dayBlocks });
  };

  const removeTimeBlock = (day: string, index: number) => {
    const dayBlocks = [...(value[day] || [])];
    dayBlocks.splice(index, 1);
    if (dayBlocks.length === 0) {
      const newValue = { ...value };
      delete newValue[day];
      onChange(newValue);
    } else {
      onChange({ ...value, [day]: dayBlocks });
    }
  };

  const isValidTimeRange = (start: string, end: string): boolean => {
    return TIME_OPTIONS.indexOf(end) > TIME_OPTIONS.indexOf(start);
  };

  const formatTime = (time: string): string => time;

  const visibleDays = allowedDays
    ? DAYS.filter(day => allowedDays[day] && allowedDays[day].length > 0)
    : DAYS;

  // Get filtered time options for a day based on allowedDays
  const getStartOptions = (day: string) => {
    const range = getTimeRange(day, allowedDays);
    if (!range) return TIME_OPTIONS.slice(0, -1); // all except midnight
    return TIME_OPTIONS.filter(t => {
      const i = TIME_OPTIONS.indexOf(t);
      return i >= TIME_OPTIONS.indexOf(range.start) && i < TIME_OPTIONS.indexOf(range.end);
    });
  };

  const getEndOptions = (day: string, currentStart: string) => {
    const range = getTimeRange(day, allowedDays);
    if (!range) return TIME_OPTIONS;
    return TIME_OPTIONS.filter(t => {
      const i = TIME_OPTIONS.indexOf(t);
      return i > TIME_OPTIONS.indexOf(currentStart) && i <= TIME_OPTIONS.indexOf(range.end);
    });
  };

  return (
    <div className="space-y-3">
      {visibleDays.map((day) => {
        const dayEnabled = isDayEnabled(day);
        const blocks = value[day] || [];
        const range = getTimeRange(day, allowedDays);

        return (
          <div
            key={day}
            className={`rounded-lg border p-3 transition-colors ${
              dayEnabled ? 'border-primary/30 bg-primary/5' : 'border-border'
            }`}
          >
            <div className="flex items-center gap-3">
              <Checkbox
                id={`day-${day}`}
                checked={dayEnabled}
                onCheckedChange={() => toggleDay(day)}
                disabled={disabled}
              />
              <div className="flex flex-col">
                <Label
                  htmlFor={`day-${day}`}
                  className={`font-medium cursor-pointer select-none ${
                    dayEnabled ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {t(`application.form.days.${day}`)}
                </Label>
                {range && (
                  <span className="text-xs text-muted-foreground">
                    {t('application.form.availableRange', 'Available')}: {range.start} — {range.end}
                  </span>
                )}
              </div>
            </div>

            {dayEnabled && (
              <div className="mt-3 ml-0 sm:ml-7 space-y-2">
                {blocks.map((block, index) => {
                  const isValid = isValidTimeRange(block.start, block.end);
                  const startOpts = getStartOptions(day);
                  const endOpts = getEndOptions(day, block.start);

                  return (
                    <div key={index} className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                      <span className="hidden sm:inline text-sm text-muted-foreground w-10">
                        {t('application.form.startTime')}
                      </span>
                      <Select
                        value={block.start}
                        onValueChange={(val) => updateTimeBlock(day, index, 'start', val)}
                        disabled={disabled}
                      >
                        <SelectTrigger className="w-20 sm:w-24 h-9">
                          <SelectValue>{formatTime(block.start)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {startOpts.map((time) => (
                            <SelectItem key={time} value={time}>
                              {formatTime(time)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <span className="text-sm text-muted-foreground">—</span>

                      <span className="hidden sm:inline text-sm text-muted-foreground w-8">
                        {t('application.form.endTime')}
                      </span>
                      <Select
                        value={block.end}
                        onValueChange={(val) => updateTimeBlock(day, index, 'end', val)}
                        disabled={disabled}
                      >
                        <SelectTrigger className={`w-20 sm:w-24 h-9 ${!isValid ? 'border-destructive' : ''}`}>
                          <SelectValue>{formatTime(block.end)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {endOpts.map((time) => (
                            <SelectItem key={time} value={time}>
                              {formatTime(time)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-muted-foreground hover:text-destructive"
                        onClick={() => removeTimeBlock(day, index)}
                        disabled={disabled}
                      >
                        <X className="h-4 w-4" />
                      </Button>

                      {!isValid && (
                        <span className="text-xs text-destructive">
                          {t('application.form.invalidTimeRange')}
                        </span>
                      )}
                    </div>
                  );
                })}

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => addTimeBlock(day)}
                  disabled={disabled}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  {t('application.form.addTimeBlock')}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
