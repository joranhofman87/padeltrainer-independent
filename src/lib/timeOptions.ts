/**
 * Half-hour time-of-day options, "HH:MM" 24-hour (00:00 … 23:30). Shared by the slot dialogs
 * (`AddSlotDialog`, `BulkCreateContent`) that each previously inlined this identical builder.
 */
export const TIME_OPTIONS: string[] = Array.from({ length: 24 * 2 }, (_, i) => {
  const hours = Math.floor(i / 2);
  const minutes = (i % 2) * 30;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
});
