/**
 * Generate an iCalendar (.ics) file from booking/session data.
 * Works with Google Calendar, Apple Calendar, Outlook, etc.
 */

interface IcsEvent {
  title: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  location?: string;
  description?: string;
}

function formatToIcsDate(isoDate: string): string {
  // Convert ISO date to ICS format: YYYYMMDDTHHmmssZ
  const d = new Date(isoDate);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function generateIcsContent(events: IcsEvent[]): string {
  const vevents = events.map((event) => {
    const lines = [
      'BEGIN:VEVENT',
      `DTSTART:${formatToIcsDate(event.startTime)}`,
      `DTEND:${formatToIcsDate(event.endTime)}`,
      `SUMMARY:${escapeIcsText(event.title)}`,
    ];
    if (event.location) {
      lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    }
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    }
    lines.push(`UID:${crypto.randomUUID()}@padeltrainer.ai`);
    lines.push(`DTSTAMP:${formatToIcsDate(new Date().toISOString())}`);
    lines.push('END:VEVENT');
    return lines.join('\r\n');
  });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PadelTrainer//Bookings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...vevents,
    'END:VCALENDAR',
  ].join('\r\n');
}

export function downloadIcsFile(events: IcsEvent[], filename = 'training-sessions.ics') {
  const content = generateIcsContent(events);
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
