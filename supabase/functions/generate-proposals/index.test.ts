import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ============================================================
// Helper functions extracted from index.ts for testing
// These mirror the logic in the edge function
// ============================================================

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const TIME_PRESETS = {
  morning: { start: 8, end: 12 },
  afternoon: { start: 12, end: 17 },
  evening: { start: 17, end: 21 },
};

interface TimeWindow {
  day?: string;
  preset?: "morning" | "afternoon" | "evening" | "weekend";
  start?: string;
  end?: string;
}

function getDayOfWeek(dateString: string): string {
  const date = new Date(dateString);
  return WEEKDAYS[date.getUTCDay()];
}

function getHour(dateString: string): number {
  return new Date(dateString).getUTCHours();
}

function getMinutes(dateString: string): number {
  return new Date(dateString).getUTCMinutes();
}

function isWeekend(dateString: string): boolean {
  const day = getDayOfWeek(dateString);
  return day === "saturday" || day === "sunday";
}

function timeToMinutes(time: string): number {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + (mins || 0);
}

function slotToMinutes(slotStart: string): number {
  const hour = getHour(slotStart);
  const minutes = getMinutes(slotStart);
  return hour * 60 + minutes;
}

function matchesTimeWindow(slotStart: string, timeWindow: TimeWindow): boolean {
  const slotDay = getDayOfWeek(slotStart);

  // New format: day + start + end (granular per-day availability)
  if (timeWindow.day && timeWindow.start && timeWindow.end) {
    // Day must match exactly
    if (slotDay !== timeWindow.day.toLowerCase()) {
      return false;
    }
    
    // Check if slot start falls within the time window
    const slotMinutes = slotToMinutes(slotStart);
    const windowStart = timeToMinutes(timeWindow.start);
    const windowEnd = timeToMinutes(timeWindow.end);
    
    // Slot start must be within player's available window
    return slotMinutes >= windowStart && slotMinutes < windowEnd;
  }

  // Legacy format: preset (morning/afternoon/evening/weekend)
  if (timeWindow.preset) {
    if (timeWindow.preset === "weekend") {
      return isWeekend(slotStart);
    }
    const preset = TIME_PRESETS[timeWindow.preset];
    if (preset) {
      const slotHour = getHour(slotStart);
      return slotHour >= preset.start && slotHour < preset.end;
    }
  }

  // Legacy format: just day without specific times
  if (timeWindow.day && !timeWindow.start && !timeWindow.end) {
    return slotDay === timeWindow.day.toLowerCase();
  }

  return false;
}

// ============================================================
// Tests
// ============================================================

Deno.test("timeToMinutes - converts time strings correctly", () => {
  assertEquals(timeToMinutes("00:00"), 0);
  assertEquals(timeToMinutes("09:00"), 540);   // 9 * 60
  assertEquals(timeToMinutes("09:30"), 570);   // 9 * 60 + 30
  assertEquals(timeToMinutes("13:00"), 780);   // 13 * 60
  assertEquals(timeToMinutes("13:30"), 810);   // 13 * 60 + 30
  assertEquals(timeToMinutes("22:00"), 1320);  // 22 * 60
  assertEquals(timeToMinutes("23:00"), 1380);  // 23 * 60
});

Deno.test("timeToMinutes - handles edge cases", () => {
  assertEquals(timeToMinutes("06:00"), 360);
  assertEquals(timeToMinutes("22:30"), 1350);
  // Handle missing minutes
  assertEquals(timeToMinutes("12"), 720);
});

Deno.test("getDayOfWeek - correctly identifies days", () => {
  // 2025-01-30 is a Thursday
  assertEquals(getDayOfWeek("2025-01-30T14:00:00Z"), "thursday");
  // 2025-01-31 is a Friday
  assertEquals(getDayOfWeek("2025-01-31T10:00:00Z"), "friday");
  // 2025-02-01 is a Saturday
  assertEquals(getDayOfWeek("2025-02-01T09:00:00Z"), "saturday");
  // 2025-02-02 is a Sunday
  assertEquals(getDayOfWeek("2025-02-02T18:00:00Z"), "sunday");
});

Deno.test("matchesTimeWindow - exact day and time match (new format)", () => {
  // Thursday at 14:00 UTC
  const slotStart = "2025-01-30T14:00:00Z";
  const timeWindow: TimeWindow = { day: "thursday", start: "13:00", end: "15:00" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), true);
});

Deno.test("matchesTimeWindow - slot at window start boundary (inclusive)", () => {
  // Thursday at exactly 13:00 UTC
  const slotStart = "2025-01-30T13:00:00Z";
  const timeWindow: TimeWindow = { day: "thursday", start: "13:00", end: "15:00" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), true);
});

Deno.test("matchesTimeWindow - slot at window end boundary (exclusive)", () => {
  // Thursday at exactly 15:00 UTC - should NOT match (end is exclusive)
  const slotStart = "2025-01-30T15:00:00Z";
  const timeWindow: TimeWindow = { day: "thursday", start: "13:00", end: "15:00" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), false);
});

Deno.test("matchesTimeWindow - slot outside time range", () => {
  // Thursday at 16:00 UTC
  const slotStart = "2025-01-30T16:00:00Z";
  const timeWindow: TimeWindow = { day: "thursday", start: "13:00", end: "15:00" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), false);
});

Deno.test("matchesTimeWindow - slot before time range", () => {
  // Thursday at 10:00 UTC
  const slotStart = "2025-01-30T10:00:00Z";
  const timeWindow: TimeWindow = { day: "thursday", start: "13:00", end: "15:00" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), false);
});

Deno.test("matchesTimeWindow - wrong day, correct time", () => {
  // Friday at 14:00 UTC (correct time, wrong day)
  const slotStart = "2025-01-31T14:00:00Z";
  const timeWindow: TimeWindow = { day: "thursday", start: "13:00", end: "15:00" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), false);
});

Deno.test("matchesTimeWindow - handles 30-minute precision", () => {
  // Thursday at 13:30 UTC
  const slotStart = "2025-01-30T13:30:00Z";
  const timeWindow: TimeWindow = { day: "thursday", start: "13:00", end: "14:00" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), true);
});

Deno.test("matchesTimeWindow - handles evening time blocks", () => {
  // Thursday at 20:30 UTC
  const slotStart = "2025-01-30T20:30:00Z";
  const timeWindow: TimeWindow = { day: "thursday", start: "20:00", end: "22:00" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), true);
});

Deno.test("matchesTimeWindow - legacy preset format: morning", () => {
  // 10:00 UTC should match morning (8-12)
  const slotStart = "2025-01-30T10:00:00Z";
  const timeWindow: TimeWindow = { preset: "morning" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), true);
});

Deno.test("matchesTimeWindow - legacy preset format: afternoon", () => {
  // 14:00 UTC should match afternoon (12-17)
  const slotStart = "2025-01-30T14:00:00Z";
  const timeWindow: TimeWindow = { preset: "afternoon" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), true);
});

Deno.test("matchesTimeWindow - legacy preset format: evening", () => {
  // 19:00 UTC should match evening (17-21)
  const slotStart = "2025-01-30T19:00:00Z";
  const timeWindow: TimeWindow = { preset: "evening" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), true);
});

Deno.test("matchesTimeWindow - legacy preset format: weekend", () => {
  // Saturday
  assertEquals(matchesTimeWindow("2025-02-01T10:00:00Z", { preset: "weekend" }), true);
  // Sunday
  assertEquals(matchesTimeWindow("2025-02-02T14:00:00Z", { preset: "weekend" }), true);
  // Thursday (not weekend)
  assertEquals(matchesTimeWindow("2025-01-30T10:00:00Z", { preset: "weekend" }), false);
});

Deno.test("matchesTimeWindow - legacy day-only format (no times)", () => {
  const slotStart = "2025-01-30T14:00:00Z"; // Thursday
  const timeWindow: TimeWindow = { day: "thursday" };
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), true);
});

Deno.test("matchesTimeWindow - unknown format returns false", () => {
  const slotStart = "2025-01-30T14:00:00Z";
  const timeWindow: TimeWindow = {};
  
  assertEquals(matchesTimeWindow(slotStart, timeWindow), false);
});

Deno.test("multiple time windows - slot matches one of multiple windows", () => {
  const playerWindows: TimeWindow[] = [
    { day: "thursday", start: "13:00", end: "15:00" },
    { day: "thursday", start: "20:00", end: "22:00" },
  ];
  
  // 14:00 should match first window
  const slot1 = "2025-01-30T14:00:00Z";
  const matches1 = playerWindows.some(tw => matchesTimeWindow(slot1, tw));
  assertEquals(matches1, true);
  
  // 21:00 should match second window
  const slot2 = "2025-01-30T21:00:00Z";
  const matches2 = playerWindows.some(tw => matchesTimeWindow(slot2, tw));
  assertEquals(matches2, true);
  
  // 16:00 should NOT match any window
  const slot3 = "2025-01-30T16:00:00Z";
  const matches3 = playerWindows.some(tw => matchesTimeWindow(slot3, tw));
  assertEquals(matches3, false);
});

Deno.test("slot filtering - excludes slots outside player availability", () => {
  const playerWindows: TimeWindow[] = [
    { day: "thursday", start: "13:00", end: "15:00" },
    { day: "thursday", start: "20:00", end: "22:00" },
  ];
  
  const slots = [
    { id: "1", start_time: "2025-01-30T14:00:00Z" }, // Thursday 14:00 - MATCH
    { id: "2", start_time: "2025-01-30T16:00:00Z" }, // Thursday 16:00 - NO MATCH
    { id: "3", start_time: "2025-01-30T21:00:00Z" }, // Thursday 21:00 - MATCH
    { id: "4", start_time: "2025-01-30T10:00:00Z" }, // Thursday 10:00 - NO MATCH
    { id: "5", start_time: "2025-01-31T14:00:00Z" }, // Friday 14:00 - NO MATCH (wrong day)
  ];
  
  const matchingSlots = slots.filter(slot =>
    playerWindows.some(tw => matchesTimeWindow(slot.start_time, tw))
  );
  
  assertEquals(matchingSlots.length, 2);
  assertEquals(matchingSlots.map(s => s.id), ["1", "3"]);
});

Deno.test("slot filtering - handles multiple days with different windows", () => {
  const playerWindows: TimeWindow[] = [
    { day: "monday", start: "08:00", end: "12:00" },
    { day: "thursday", start: "18:00", end: "21:00" },
  ];
  
  const slots = [
    { id: "1", start_time: "2025-01-27T09:00:00Z" }, // Monday 09:00 - MATCH
    { id: "2", start_time: "2025-01-27T14:00:00Z" }, // Monday 14:00 - NO MATCH (wrong time)
    { id: "3", start_time: "2025-01-30T19:00:00Z" }, // Thursday 19:00 - MATCH
    { id: "4", start_time: "2025-01-30T10:00:00Z" }, // Thursday 10:00 - NO MATCH (wrong time)
    { id: "5", start_time: "2025-01-28T09:00:00Z" }, // Tuesday 09:00 - NO MATCH (wrong day)
  ];
  
  const matchingSlots = slots.filter(slot =>
    playerWindows.some(tw => matchesTimeWindow(slot.start_time, tw))
  );
  
  assertEquals(matchingSlots.length, 2);
  assertEquals(matchingSlots.map(s => s.id), ["1", "3"]);
});
