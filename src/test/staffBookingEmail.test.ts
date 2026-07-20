// @vitest-environment node
// renderStaffBookingEmail — the shared STAFF paid-booking email renderer (PR 6b).
//
// SECURITY (PR 6b Codex P1): the legacy send-email path deep-escaped `data` before rendering;
// the extracted renderer is now called with RAW values by BOTH callers — the outbox path
// (sendStaffBookingNotifications, with a guest-controlled playerName) AND send-email (which
// passes its RAW dataRaw, NOT its deep-escaped `data`). So the renderer must be safe BY
// CONSTRUCTION: HTML-escape every body interpolation exactly once (no double-escape), and keep
// the subject a plain-text header (strip CR/LF, do not HTML-escape).
import { describe, it, expect } from 'vitest';
import { renderStaffBookingEmail } from '../../supabase/functions/_shared/staff-booking-email.ts';

describe('renderStaffBookingEmail — safe by construction', () => {
  it('HTML-escapes a malicious playerName in the body (no raw markup injected)', () => {
    const { html } = renderStaffBookingEmail({ recipientName: 'Mgr', playerName: '<script>alert(1)</script>', sessions: [{ date: 'Mon', time: '10:00', location: 'Hal 1', name: 'Cyclus' }] });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('HTML-escapes recipientName, session.name and session.location', () => {
    const { html } = renderStaffBookingEmail({
      recipientName: '<b>boss</b>',
      playerName: 'Player',
      sessions: [{ date: 'Mon', time: '10:00', location: '<img src=x onerror=hack>', name: '<i>Zomer</i>' }],
    });
    expect(html).not.toContain('<b>boss</b>');
    expect(html).not.toContain('<img src=x onerror=hack>');
    expect(html).not.toContain('<i>Zomer</i>');
    expect(html).toContain('&lt;b&gt;boss&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=hack&gt;');
    expect(html).toContain('&lt;i&gt;Zomer&lt;/i&gt;');
  });

  it('HTML-escapes the amount', () => {
    const { html } = renderStaffBookingEmail({ recipientName: 'Mgr', playerName: 'P', sessions: [], amount: '<b>€5</b>' });
    expect(html).not.toContain('<b>€5</b>');
    expect(html).toContain('&lt;b&gt;€5&lt;/b&gt;');
  });

  it('escapes exactly ONCE — no double-escape (mirrors the legacy send-email path, which now passes RAW dataRaw)', () => {
    const { html } = renderStaffBookingEmail({ recipientName: 'A & B', playerName: 'Tom < Jerry & Co', sessions: [] });
    expect(html).toContain('Tom &lt; Jerry &amp; Co'); // single escape
    expect(html).not.toContain('&amp;lt;');            // NOT double-escaped
    expect(html).not.toContain('&amp;amp;');
    expect(html).toContain('A &amp; B');
  });

  it('subject is a PLAIN-TEXT header: CR/LF stripped (no header injection), NOT HTML-escaped', () => {
    const injected = renderStaffBookingEmail({ playerName: 'Evil\r\nBcc: attacker@x.com', sessions: [] });
    expect(injected.subject).not.toMatch(/[\r\n]/);
    expect(injected.subject).toContain('Bcc: attacker@x.com'); // flattened onto one line, harmless as plain text

    const amp = renderStaffBookingEmail({ playerName: 'Tom & Jerry', sessions: [] });
    expect(amp.subject).toContain('Tom & Jerry');   // plain text — NOT HTML-escaped to &amp;
    expect(amp.subject).not.toContain('&amp;');
  });

  it('pluralizes the subject by session count', () => {
    expect(renderStaffBookingEmail({ playerName: 'P', sessions: [{}] }).subject).not.toContain('sessions)');
    expect(renderStaffBookingEmail({ playerName: 'P', sessions: [{}, {}] }).subject).toContain('(2 sessions)');
  });

  it('academy managers see the amount; trainers (no amount) do not', () => {
    expect(renderStaffBookingEmail({ playerName: 'P', sessions: [{}], amount: '€25.00' }).html).toContain('Amount paid');
    expect(renderStaffBookingEmail({ playerName: 'P', sessions: [{}] }).html).not.toContain('Amount paid');
  });
});
