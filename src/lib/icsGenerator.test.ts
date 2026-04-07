import { describe, it, expect, vi } from 'vitest';
import { generateIcsContent } from './icsGenerator';

// Mock crypto.randomUUID for deterministic output
vi.stubGlobal('crypto', {
  randomUUID: () => 'test-uuid-1234',
});

describe('generateIcsContent', () => {
  it('generates valid VCALENDAR wrapper', () => {
    const content = generateIcsContent([]);
    expect(content).toContain('BEGIN:VCALENDAR');
    expect(content).toContain('END:VCALENDAR');
    expect(content).toContain('VERSION:2.0');
    expect(content).toContain('PRODID:-//PadelTrainer//Bookings//EN');
  });

  it('generates VEVENT with required fields', () => {
    const content = generateIcsContent([
      {
        title: 'Padel Training',
        startTime: '2025-06-15T10:00:00Z',
        endTime: '2025-06-15T11:00:00Z',
      },
    ]);

    expect(content).toContain('BEGIN:VEVENT');
    expect(content).toContain('END:VEVENT');
    expect(content).toContain('SUMMARY:Padel Training');
    expect(content).toContain('DTSTART:20250615T100000Z');
    expect(content).toContain('DTEND:20250615T110000Z');
    expect(content).toContain('UID:test-uuid-1234@padeltrainer.ai');
  });

  it('includes optional location and description', () => {
    const content = generateIcsContent([
      {
        title: 'Session',
        startTime: '2025-06-15T10:00:00Z',
        endTime: '2025-06-15T11:00:00Z',
        location: 'Padel Club Amsterdam',
        description: 'Group training session',
      },
    ]);

    expect(content).toContain('LOCATION:Padel Club Amsterdam');
    expect(content).toContain('DESCRIPTION:Group training session');
  });

  it('escapes special characters in text fields', () => {
    const content = generateIcsContent([
      {
        title: 'Training; with, special\\chars',
        startTime: '2025-06-15T10:00:00Z',
        endTime: '2025-06-15T11:00:00Z',
        description: 'Line1\nLine2',
      },
    ]);

    expect(content).toContain('SUMMARY:Training\\; with\\, special\\\\chars');
    expect(content).toContain('DESCRIPTION:Line1\\nLine2');
  });

  it('generates multiple events', () => {
    const content = generateIcsContent([
      { title: 'Event 1', startTime: '2025-06-15T10:00:00Z', endTime: '2025-06-15T11:00:00Z' },
      { title: 'Event 2', startTime: '2025-06-16T10:00:00Z', endTime: '2025-06-16T11:00:00Z' },
    ]);

    const eventCount = (content.match(/BEGIN:VEVENT/g) || []).length;
    expect(eventCount).toBe(2);
  });

  it('uses CRLF line endings', () => {
    const content = generateIcsContent([
      { title: 'Test', startTime: '2025-06-15T10:00:00Z', endTime: '2025-06-15T11:00:00Z' },
    ]);

    expect(content).toContain('\r\n');
  });
});
