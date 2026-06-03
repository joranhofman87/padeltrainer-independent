export type AcademyCalendarTabValue =
  | "week"
  | "day"
  | "month"
  | "list"
  | "create"
  | "hours"
  | "reports";

/** Internal tab value; `cycles` URL param is an alias for `list`. */
export type AcademyCalendarTabInput = AcademyCalendarTabValue | "cycles";

const VALID_TABS = new Set<string>([
  "week",
  "day",
  "month",
  "list",
  "cycles",
  "create",
  "hours",
  "reports",
]);

/**
 * Parse academy calendar `tab` query param.
 * Legacy: overview→week, manage→day, cycles→list.
 */
export function parseAcademyCalendarTab(
  rawTab: string | null,
): AcademyCalendarTabValue {
  const tab = rawTab || "week";
  if (tab === "overview") return "week";
  if (tab === "manage") return "day";
  if (tab === "cycles") return "list";
  if (VALID_TABS.has(tab)) return tab as AcademyCalendarTabValue;
  return "week";
}

export function isAcademyCalendarListTab(rawTab: string | null): boolean {
  const tab = rawTab || "week";
  return tab === "list" || tab === "cycles";
}

export const ACADEMY_CALENDAR_PRIMARY_TABS: AcademyCalendarTabValue[] = [
  "week",
  "day",
  "month",
  "list",
];

export function isAcademyCalendarScheduleTab(tab: AcademyCalendarTabValue): boolean {
  return tab === "week" || tab === "day" || tab === "month";
}
