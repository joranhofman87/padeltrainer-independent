import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The single shared home for date inputs. Forces `type="date"` and normalizes
 * the native control so every date field across the app looks and behaves the
 * same:
 *  - `min-w-0` lets the field respect its container (a native `<input type="date">`
 *    has an intrinsic min-width that otherwise overflows narrow grid columns,
 *    unlike every other Input which is happy to shrink).
 *
 * It forwards its ref and every other prop straight through to {@link Input},
 * so it is a drop-in for `<Input type="date" … />` (the `type` prop is omitted
 * because it is fixed). One seam to later swap the native picker for a custom
 * one without touching call sites.
 *
 * Prefer this over a raw `<Input type="date">` — that pattern is blocked by the
 * `no-restricted-syntax` lint rule so date fields can't drift apart again.
 */
const DateInputField = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentPropsWithoutRef<typeof Input>, "type">
>(({ className, ...props }, ref) => {
  return (
    // eslint-disable-next-line no-restricted-syntax -- this is THE sanctioned <Input type="date">
    <Input ref={ref} type="date" className={cn("min-w-0", className)} {...props} />
  );
});
DateInputField.displayName = "DateInputField";

export { DateInputField };
