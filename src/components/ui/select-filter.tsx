import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** The sentinel value meaning "no filter / show all". */
export const ALL_FILTER = "all";

export interface SelectFilterOption {
  value: string;
  label: React.ReactNode;
}

export interface SelectFilterProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Label for the leading "all" option (and the default trigger placeholder). */
  allLabel: string;
  /** The non-"all" options, rendered in order after the "all" item. */
  options: SelectFilterOption[];
  /** Trigger placeholder (shown only when `value` is empty). Defaults to `allLabel`. */
  placeholder?: string;
  /**
   * Trigger classes. REPLACES the canonical default (`"w-full sm:w-[160px]"`)
   * rather than merging with it — a plain `w-[140px]` override must not fight a
   * leftover `sm:` default at breakpoints — so pass the full class list.
   */
  triggerClassName?: string;
  /** The sentinel value for the "all" option. Defaults to {@link ALL_FILTER}. */
  allValue?: string;
  ariaLabel?: string;
  disabled?: boolean;
  id?: string;
}

/**
 * The single shared "All X" list-filter dropdown: a shadcn `Select` whose first
 * item is an "all" sentinel (meaning "no filter"), followed by caller-supplied
 * options. Value contract: a string in / out, and `value === allValue` ("all")
 * means unfiltered — the filtering itself stays in the page. This replaces the
 * ~30 hand-wired `Select + <SelectItem value="all">` blocks copied across the
 * list pages, standardizing the sentinel and trigger while leaving each screen's
 * options and filter logic untouched.
 */
export function SelectFilter({
  value,
  onValueChange,
  allLabel,
  options,
  placeholder,
  triggerClassName,
  allValue = ALL_FILTER,
  ariaLabel,
  disabled,
  id,
}: SelectFilterProps) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={cn(triggerClassName ?? "w-full sm:w-[160px]")}
      >
        <SelectValue placeholder={placeholder ?? allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={allValue}>{allLabel}</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
