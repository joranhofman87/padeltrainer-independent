import * as React from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getDateFnsLocale } from "@/lib/dateFnsLocale";
import { cn } from "@/lib/utils";

export interface DatePickerPopoverProps {
  /** The selected date, or `undefined` when nothing is picked yet. */
  value: Date | undefined;
  /**
   * Fired with the newly-selected date. Receives `undefined` when the selected
   * day is toggled off — a caller that must never clear should guard:
   * `onChange={(d) => d && setDate(d)}`.
   */
  onChange: (date: Date | undefined) => void;
  /** Trigger label when no date is picked. Defaults to a localized "Pick a date". */
  placeholder?: string;
  /** date-fns format for the trigger label. Default `"d MMM yyyy"` (always locale-aware). */
  displayFormat?: string;
  /** Disable specific days in the calendar (e.g. past dates). */
  disabled?: (date: Date) => boolean;
  /** Disable the whole trigger button. */
  triggerDisabled?: boolean;
  align?: "start" | "center" | "end";
  /** Extra classes on the trigger button. */
  className?: string;
  size?: React.ComponentProps<typeof Button>["size"];
  id?: string;
  ariaLabel?: string;
}

/**
 * The single shared pop-up (calendar) date picker: a trigger button + Popover +
 * shadcn Calendar in single mode, with a locale-aware label.
 *
 * This replaces the ~25 hand-wired `Popover + Button(CalendarIcon) + Calendar`
 * blocks that had drifted apart (localized `d MMM yyyy` on invoice screens vs
 * hardcoded English "Pick a date" + `PPP` elsewhere). It is the popup counterpart
 * to {@link DateInputField} (the native typed-date field) — SAME value type (a
 * `Date`), different UX. Value contract: a `Date` in, a `Date` (or `undefined`)
 * out; callers still convert to `yyyy-MM-dd` at submit exactly as before, so
 * adopting this never changes what is stored.
 */
export function DatePickerPopover({
  value,
  onChange,
  placeholder,
  displayFormat = "d MMM yyyy",
  disabled,
  triggerDisabled,
  align = "start",
  className,
  size = "default",
  id,
  ariaLabel,
}: DatePickerPopoverProps) {
  const { t, i18n } = useTranslation("common");
  const locale = getDateFnsLocale(i18n.language);
  const label = value
    ? format(value, displayFormat, { locale })
    : placeholder ?? t("datePicker.pickDate", "Pick a date");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size={size}
          disabled={triggerDisabled}
          aria-label={ariaLabel}
          className={cn(
            "justify-start text-left font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={align}>
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          disabled={disabled}
          initialFocus
          className="p-3 pointer-events-auto"
        />
      </PopoverContent>
    </Popover>
  );
}
