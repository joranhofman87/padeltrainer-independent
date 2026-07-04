import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TIME_OPTIONS } from "@/lib/timeOptions";
import { cn } from "@/lib/utils";

export interface TimeSelectProps {
  /** Selected "HH:MM" 24-hour value, or `undefined` when nothing is picked. */
  value: string | undefined;
  onValueChange: (value: string) => void;
  /**
   * The "HH:MM" options to offer. Defaults to the shared full-day half-hour list
   * ({@link TIME_OPTIONS}). Pass a range-limited list (e.g.
   * `buildHalfHourOptions(6, 23)`) to preserve a screen's narrower window.
   */
  options?: string[];
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes for the trigger, e.g. `"h-8"` or `"w-[90px]"`. */
  triggerClassName?: string;
  ariaLabel?: string;
  id?: string;
}

/**
 * The single shared time-of-day dropdown: a shadcn `Select` over half-hour
 * "HH:MM" options. Value contract: a "HH:MM" string in, a "HH:MM" string out —
 * a drop-in for the hand-wired `Select + TIME_OPTIONS.map(...)` blocks that had
 * been copied across the slot / bulk / generator / proposal screens. It is the
 * dropdown counterpart to the native `<input type="time">` (which allows
 * arbitrary minutes); adopting this never changes what is stored.
 */
export function TimeSelect({
  value,
  onValueChange,
  options = TIME_OPTIONS,
  placeholder,
  disabled,
  triggerClassName,
  ariaLabel,
  id,
}: TimeSelectProps) {
  // Legacy tolerance: sites migrated from free-entry <input type="time"> may hold an
  // off-grid stored value (e.g. "09:15"). Splice it into the list (sorted) so the
  // trigger never renders blank and the value stays selectable until changed — new
  // picks still snap to the half-hour grid. No-op when the value is on-grid.
  const renderedOptions =
    value && !options.includes(value)
      ? [...options, value].sort()
      : options;

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn(triggerClassName)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {renderedOptions.map((time) => (
          <SelectItem key={time} value={time}>
            {time}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
