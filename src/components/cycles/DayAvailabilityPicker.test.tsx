import { describe, it, expect } from 'vitest';

// ============================================================
// Test the core data structures and logic used by DayAvailabilityPicker
// ============================================================

const TIME_OPTIONS: string[] = [];
for (let hour = 6; hour <= 22; hour++) {
  TIME_OPTIONS.push(`${hour.toString().padStart(2, '0')}:00`);
  if (hour < 22) {
    TIME_OPTIONS.push(`${hour.toString().padStart(2, '0')}:30`);
  }
}
TIME_OPTIONS.push('22:30', '23:00');

interface TimeBlock {
  start: string;
  end: string;
}

interface DayAvailability {
  [day: string]: TimeBlock[];
}

// Helper function to check time range validity (mirrors component logic)
function isValidTimeRange(start: string, end: string): boolean {
  return TIME_OPTIONS.indexOf(end) > TIME_OPTIONS.indexOf(start);
}

// Helper to convert DayAvailability to TimeWindow[] format for proposals
function toTimeWindows(availability: DayAvailability): Array<{ day: string; start: string; end: string }> {
  const windows: Array<{ day: string; start: string; end: string }> = [];
  for (const [day, blocks] of Object.entries(availability)) {
    for (const block of blocks) {
      windows.push({ day, start: block.start, end: block.end });
    }
  }
  return windows;
}

describe('DayAvailabilityPicker - Time Options', () => {
  it('generates time options from 06:00 to 23:00', () => {
    expect(TIME_OPTIONS[0]).toBe('06:00');
    expect(TIME_OPTIONS).toContain('22:30');
    expect(TIME_OPTIONS).toContain('23:00');
  });

  it('includes 30-minute increments', () => {
    expect(TIME_OPTIONS).toContain('09:00');
    expect(TIME_OPTIONS).toContain('09:30');
    expect(TIME_OPTIONS).toContain('13:00');
    expect(TIME_OPTIONS).toContain('13:30');
  });

  it('has correct number of options (06:00-22:00 = 33 half-hours + 22:30 + 23:00)', () => {
    // 06:00 to 22:00 = 17 hours * 2 slots = 34 slots, minus 22:30 which is added separately
    // Actually: 06:00, 06:30, ..., 22:00 = 33 slots, plus 22:30, 23:00 = 35 total
    expect(TIME_OPTIONS.length).toBe(35);
  });
});

describe('DayAvailabilityPicker - Time Validation', () => {
  it('returns true when end time is after start time', () => {
    expect(isValidTimeRange('09:00', '12:00')).toBe(true);
    expect(isValidTimeRange('13:30', '17:00')).toBe(true);
    expect(isValidTimeRange('20:00', '22:30')).toBe(true);
  });

  it('returns false when end time equals start time', () => {
    expect(isValidTimeRange('09:00', '09:00')).toBe(false);
    expect(isValidTimeRange('17:00', '17:00')).toBe(false);
  });

  it('returns false when end time is before start time', () => {
    expect(isValidTimeRange('12:00', '09:00')).toBe(false);
    expect(isValidTimeRange('17:00', '13:30')).toBe(false);
    expect(isValidTimeRange('22:00', '06:00')).toBe(false);
  });

  it('allows adjacent half-hour slots', () => {
    expect(isValidTimeRange('09:00', '09:30')).toBe(true);
    expect(isValidTimeRange('13:30', '14:00')).toBe(true);
  });
});

describe('DayAvailabilityPicker - Data Conversion', () => {
  it('converts empty availability to empty windows', () => {
    const availability: DayAvailability = {};
    const windows = toTimeWindows(availability);
    expect(windows).toHaveLength(0);
  });

  it('converts single day with single block', () => {
    const availability: DayAvailability = {
      thursday: [{ start: '09:00', end: '17:00' }],
    };
    const windows = toTimeWindows(availability);
    
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({ day: 'thursday', start: '09:00', end: '17:00' });
  });

  it('converts single day with multiple blocks', () => {
    const availability: DayAvailability = {
      thursday: [
        { start: '09:00', end: '12:00' },
        { start: '18:00', end: '21:00' },
      ],
    };
    const windows = toTimeWindows(availability);
    
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ day: 'thursday', start: '09:00', end: '12:00' });
    expect(windows[1]).toEqual({ day: 'thursday', start: '18:00', end: '21:00' });
  });

  it('converts multiple days with different blocks', () => {
    const availability: DayAvailability = {
      monday: [{ start: '08:00', end: '12:00' }],
      thursday: [
        { start: '13:00', end: '15:00' },
        { start: '20:00', end: '22:00' },
      ],
      saturday: [{ start: '10:00', end: '14:00' }],
    };
    const windows = toTimeWindows(availability);
    
    expect(windows).toHaveLength(4);
    
    // Check all days are represented
    const days = windows.map(w => w.day);
    expect(days).toContain('monday');
    expect(days).toContain('thursday');
    expect(days).toContain('saturday');
    
    // Check thursday has 2 blocks
    const thursdayBlocks = windows.filter(w => w.day === 'thursday');
    expect(thursdayBlocks).toHaveLength(2);
  });
});

describe('DayAvailabilityPicker - Edge Cases', () => {
  it('handles early morning availability (06:00 start)', () => {
    const availability: DayAvailability = {
      monday: [{ start: '06:00', end: '08:00' }],
    };
    const windows = toTimeWindows(availability);
    
    expect(windows[0]).toEqual({ day: 'monday', start: '06:00', end: '08:00' });
    expect(isValidTimeRange('06:00', '08:00')).toBe(true);
  });

  it('handles late evening availability (ending at 23:00)', () => {
    const availability: DayAvailability = {
      friday: [{ start: '20:00', end: '23:00' }],
    };
    const windows = toTimeWindows(availability);
    
    expect(windows[0]).toEqual({ day: 'friday', start: '20:00', end: '23:00' });
    expect(isValidTimeRange('20:00', '23:00')).toBe(true);
  });

  it('handles full day availability', () => {
    const availability: DayAvailability = {
      sunday: [{ start: '06:00', end: '23:00' }],
    };
    const windows = toTimeWindows(availability);
    
    expect(windows[0]).toEqual({ day: 'sunday', start: '06:00', end: '23:00' });
  });

  it('handles all days of the week', () => {
    const availability: DayAvailability = {
      monday: [{ start: '09:00', end: '17:00' }],
      tuesday: [{ start: '09:00', end: '17:00' }],
      wednesday: [{ start: '09:00', end: '17:00' }],
      thursday: [{ start: '09:00', end: '17:00' }],
      friday: [{ start: '09:00', end: '17:00' }],
      saturday: [{ start: '10:00', end: '14:00' }],
      sunday: [{ start: '10:00', end: '14:00' }],
    };
    const windows = toTimeWindows(availability);
    
    expect(windows).toHaveLength(7);
  });
});
