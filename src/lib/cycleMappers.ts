// Pure DB-row → typed-object mappers, extracted from lib/cycles.ts (god-file split). Zero runtime
// behavior change; cycles.ts imports these for its read functions.
import type { Cycle, CycleSettings, PriceTableRow, IntakeRequest, TimeWindow, ProposedAssignment, RationaleItem } from './cycleTypes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toCycle(row: Record<string, any>): Cycle {
  return {
    ...row,
    settings: (row.settings || {}) as CycleSettings,
    price_table: (row.price_table || null) as unknown as PriceTableRow[] | null,
  } as Cycle;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toIntakeRequest(row: Record<string, any>): IntakeRequest {
  return {
    ...row,
    preferred_time_windows: (row.preferred_time_windows || []) as unknown as TimeWindow[],
  } as IntakeRequest;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toProposedAssignment(row: Record<string, any>): ProposedAssignment {
  return {
    ...row,
    rationale: (row.rationale || null) as unknown as RationaleItem[] | null,
  } as ProposedAssignment;
}
