// The STAFF paid-booking notification renderer — the "new booking 🎾" email sent to a
// slot's trainer (no amount — owner decision: trainer emails carry the booking(s) only)
// and to academy managers (amount included).
//
// Extracted from send-email's `new_public_booking_admin` case (PR 6b) so the SAME copy is
// used whether it is rendered by the legacy send-email path OR composed for the notification
// outbox (booking_confirmed_staff). Keep this the single source of the staff email copy.
//
// SAFE BY CONSTRUCTION: every value interpolated into the HTML BODY is HTML-escaped HERE, so
// BOTH callers pass RAW values — the outbox path (sendStaffBookingNotifications) with a raw,
// guest-controlled playerName, and send-email which passes its RAW `dataRaw` (NOT its
// deep-escaped `data`, which would double-escape). The subject is a plain-text header, so it
// is CR/LF-stripped (header-injection safety) rather than HTML-escaped.

const BRAND_ORANGE = "#f45d25";
const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;

/** HTML-escape a value interpolated into the email BODY. */
const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A subject is a plain-text header: collapse CR/LF (no header injection), do NOT HTML-escape. */
const plainHeader = (v: unknown): string => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

export type StaffBookingSession = { date?: string; time?: string; location?: string; name?: string };

export function renderStaffBookingEmail(data: {
  recipientName?: string;
  playerName?: string;
  sessions?: StaffBookingSession[];
  /** Present for academy managers (e.g. "€45.00"), ABSENT for trainers. */
  amount?: string;
}): { subject: string; html: string } {
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const sessionRows = sessions
    .map((sess) => `
              <tr>
                <td style="padding: 6px 12px 6px 0; white-space: nowrap;"><strong>${esc(sess.date)}</strong></td>
                <td style="padding: 6px 12px 6px 0; white-space: nowrap;">${esc(sess.time)}</td>
                <td style="padding: 6px 12px 6px 0;">${[sess.name, sess.location].filter(Boolean).map(esc).join(" · ")}</td>
              </tr>`)
    .join("");
  const count = sessions.length;
  return {
    subject: `New booking: ${plainHeader(data.playerName)}${count > 1 ? ` (${count} sessions)` : ""} 🎾`,
    html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">New booking 🎾</h1>
            <p>Hi ${esc(data.recipientName)},</p>
            <p><strong>${esc(data.playerName)}</strong> just booked ${count === 1 ? "a session" : `${count} sessions`} and paid online.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <table style="border-collapse: collapse; width: 100%;">${sessionRows}
              </table>
              ${data.amount ? `<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 12px 0;" /><p style="margin: 4px 0;"><strong>Amount paid:</strong> ${esc(data.amount)}</p>` : ""}
            </div>
            <p>The booking is confirmed and visible in your agenda.</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
  };
}
