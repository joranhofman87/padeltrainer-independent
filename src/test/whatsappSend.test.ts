// @vitest-environment node
// PR 9: the Twilio WhatsApp send helper. Two things are pinned here:
//
//   1. THE GUARDS REFUSE BEFORE ANY NETWORK CALL. Every "no-send" path asserts fetch was never
//      invoked — a guard that returns {ok:false} *after* Twilio already accepted the message
//      would look identical in the return value while having messaged a real person.
//   2. RETRYABILITY IS CLASSIFIED CORRECTLY. Getting this backwards is expensive in both
//      directions: a terminal 401 permanently fails the whole queue over a wrong env var, and
//      a retryable 400 burns the attempt budget re-sending something Twilio will never accept.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendWhatsAppMessage,
  normalizeWhatsAppSender,
  whatsappFailureAction,
} from '../../supabase/functions/_shared/whatsapp-send.ts';

const AUTH = { accountSid: 'AC00000000000000000000000000000001', authToken: 'tok' };
const FROM = 'whatsapp:+3197010254321';
const TO = '+31612345678';

let fetchMock: ReturnType<typeof vi.fn>;

const respond = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Parse the form body of the Nth fetch call. */
const sentForm = (n = 0) => new URLSearchParams(fetchMock.mock.calls[n][1].body as string);

describe('normalizeWhatsAppSender', () => {
  it('adds the whatsapp: prefix Twilio requires to a bare E.164 number', () => {
    // the live TWILIO_WHATSAPP_FROM was configured WITHOUT the prefix; six missing characters
    // should not be able to block the entire queue
    expect(normalizeWhatsAppSender('+3197010254321')).toBe('whatsapp:+3197010254321');
  });

  it('keeps an already-prefixed sender and a Messaging Service SID as-is', () => {
    expect(normalizeWhatsAppSender('whatsapp:+3197010254321')).toBe('whatsapp:+3197010254321');
    expect(normalizeWhatsAppSender('MG0123456789abcdef0123456789abcdef')).toBe('MG0123456789abcdef0123456789abcdef');
  });

  it('returns null for anything it cannot make sense of', () => {
    expect(normalizeWhatsAppSender('')).toBeNull();
    expect(normalizeWhatsAppSender('06 1234 5678')).toBeNull();   // not E.164 — normalize first
    expect(normalizeWhatsAppSender('whatsapp:junk')).toBeNull();
  });
});

describe('sendWhatsAppMessage — fail-closed guards (no network call)', () => {
  it('refuses a non-E.164 recipient', async () => {
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: '06 12345678', contentSid: 'HX1' });
    expect(r).toMatchObject({ ok: false, error: 'invalid_phone', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when there is NO template SID and no body — never sends an empty message', async () => {
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO });
    expect(r).toMatchObject({ ok: false, error: 'no_content', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when credentials are missing (retryable — config self-heals)', async () => {
    const r1 = await sendWhatsAppMessage({ accountSid: '' }, { from: FROM, to: TO, contentSid: 'HX1' });
    expect(r1).toMatchObject({ ok: false, error: 'missing_account_sid', retryable: true });
    const r2 = await sendWhatsAppMessage({ accountSid: AUTH.accountSid }, { from: FROM, to: TO, contentSid: 'HX1' });
    expect(r2).toMatchObject({ ok: false, error: 'missing_twilio_credentials', retryable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unusable sender', async () => {
    const r = await sendWhatsAppMessage(AUTH, { from: 'nonsense', to: TO, contentSid: 'HX1' });
    expect(r).toMatchObject({ ok: false, error: 'invalid_sender', retryable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendWhatsAppMessage — request shape', () => {
  it('sends template mode with ContentSid + positional ContentVariables', async () => {
    fetchMock.mockResolvedValue(respond(201, { sid: 'SMabc' }));
    const r = await sendWhatsAppMessage(AUTH, {
      from: FROM, to: TO,
      contentSid: 'HX0123456789abcdef0123456789abcdef',
      contentVariables: { '1': 'Tom', '2': 'maandag' },
      statusCallback: 'https://x.test/hook',
    });
    expect(r).toMatchObject({ ok: true, sid: 'SMabc' });

    const form = sentForm();
    expect(form.get('To')).toBe('whatsapp:+31612345678');
    expect(form.get('From')).toBe(FROM);
    expect(form.get('ContentSid')).toBe('HX0123456789abcdef0123456789abcdef');
    expect(JSON.parse(form.get('ContentVariables')!)).toEqual({ '1': 'Tom', '2': 'maandag' });
    expect(form.get('StatusCallback')).toBe('https://x.test/hook');
    expect(form.get('Body')).toBeNull();
  });

  it('uses MessagingServiceSid (not From) when the sender is an MG SID', async () => {
    fetchMock.mockResolvedValue(respond(201, { sid: 'SMabc' }));
    await sendWhatsAppMessage(AUTH, {
      from: 'MG0123456789abcdef0123456789abcdef', to: TO, contentSid: 'HX1',
    });
    const form = sentForm();
    expect(form.get('MessagingServiceSid')).toBe('MG0123456789abcdef0123456789abcdef');
    expect(form.get('From')).toBeNull();
  });

  it('prefers the API key pair over the account auth token for outbound auth', async () => {
    fetchMock.mockResolvedValue(respond(201, { sid: 'SMabc' }));
    await sendWhatsAppMessage(
      { ...AUTH, apiKeySid: 'SK00000000000000000000000000000002', apiKeySecret: 'secret' },
      { from: FROM, to: TO, contentSid: 'HX1' },
    );
    const authHeader = fetchMock.mock.calls[0][1].headers.Authorization as string;
    const [user, pass] = atob(authHeader.replace('Basic ', '')).split(':');
    expect(user).toBe('SK00000000000000000000000000000002');
    expect(pass).toBe('secret');
    // the account SID still selects the REST resource path
    expect(fetchMock.mock.calls[0][0]).toContain(`/Accounts/${AUTH.accountSid}/Messages.json`);
  });

  it('falls back to free-form Body only when no ContentSid is supplied', async () => {
    fetchMock.mockResolvedValue(respond(201, { sid: 'SMabc' }));
    await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, body: 'hoi' });
    expect(sentForm().get('Body')).toBe('hoi');
    expect(sentForm().get('ContentSid')).toBeNull();
  });
});

describe('sendWhatsAppMessage — error classification', () => {
  it('flags 401 as a GLOBAL configError, without burning in-request retries', async () => {
    // this is the live situation: SID and token belong to different accounts. configError tells
    // the worker to DEFER the row rather than spend an attempt — "retryable" alone is not
    // enough, since the outbox still fails a row once attempts >= max_attempts.
    fetchMock.mockResolvedValue(respond(401, { message: 'Authenticate', code: 20003 }));
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' });
    expect(r).toMatchObject({ ok: false, retryable: true, configError: true, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((r as { error: string }).error).toContain('20003');
  });

  it('marks every pre-flight CONFIG refusal as configError — and row faults NOT', async () => {
    // the distinction the worker keys its defer-vs-fail decision on, pinned in one place
    const config = [
      await sendWhatsAppMessage({ accountSid: '' }, { from: FROM, to: TO, contentSid: 'HX1' }),
      await sendWhatsAppMessage({ accountSid: AUTH.accountSid }, { from: FROM, to: TO, contentSid: 'HX1' }),
      await sendWhatsAppMessage(AUTH, { from: 'nonsense', to: TO, contentSid: 'HX1' }),
    ];
    for (const r of config) expect(r).toMatchObject({ ok: false, configError: true });

    // these are properties of THIS message and must still consume/terminate normally
    const rowFaults = [
      await sendWhatsAppMessage(AUTH, { from: FROM, to: 'garbage', contentSid: 'HX1' }),
      await sendWhatsAppMessage(AUTH, { from: FROM, to: TO }),
    ];
    for (const r of rowFaults) {
      expect(r).toMatchObject({ ok: false, retryable: false });
      expect((r as { configError?: true }).configError).toBeUndefined();
    }
  });

  it('does NOT mark an ordinary transient failure as configError', async () => {
    fetchMock.mockResolvedValue(respond(503, { message: 'Service Unavailable' }));
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' }, { maxAttempts: 1 });
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect((r as { configError?: true }).configError).toBeUndefined();
  });

  it('treats a 400 for a bad ContentSid as CONFIG, not a row verdict', async () => {
    // the ContentSid comes from an env var, so an unapproved / wrong-account / mistyped one is
    // wrong for EVERY row. Terminal here would destroy the whole queue on its FIRST drain —
    // faster and more total than the max_attempts exhaustion this defers around.
    fetchMock.mockResolvedValue(respond(400, { message: 'Invalid ContentSid', code: 21656 }));
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HXbad' });
    expect(r).toMatchObject({ ok: false, retryable: true, configError: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);   // no point retrying it in-request
  });

  it('treats a rejected-but-syntactically-valid sender as CONFIG too', async () => {
    fetchMock.mockResolvedValue(respond(400, { message: 'From is not a valid WhatsApp sender', code: 63007 }));
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' });
    expect(r).toMatchObject({ ok: false, configError: true });
  });

  it('RECIPIENT-specific codes terminal-fail — they must never sit in the defer queue', async () => {
    // the counterweight to the broad 4xx bucket: no config fix makes these deliverable, so
    // parking them for 24h would just delay an inevitable failure (and, for 21610, sit on an
    // unsubscribe signal)
    const cases = [
      [21610, 'unsubscribed'],
      [21614, 'not a mobile'],
      [21211, 'invalid To'],
      [63024, 'invalid message recipient — not a WhatsApp user / has not accepted ToS'],
      [63032, 'WhatsApp limitation — recipient number is in a Meta experiment'],
    ] as const;
    for (const [code, label] of cases) {
      fetchMock.mockResolvedValue(respond(400, { message: label, code }));
      const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' });
      expect(r).toMatchObject({ ok: false, retryable: false, rowFault: true, code });
      expect((r as { configError?: true }).configError).toBeUndefined();
    }
  });

  it('treats the 63018 channel rate limit as TRANSIENT whatever HTTP status carries it', async () => {
    // Twilio's docs do not state which status 63018 arrives with, so it is classified by CODE:
    // if it ever comes as a 400 it must not be mistaken for a config gap and parked for a day.
    for (const status of [429, 400]) {
      fetchMock.mockResolvedValue(respond(status, { message: 'Rate limit exceeded', code: 63018 }));
      const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' }, { maxAttempts: 1 });
      expect(r).toMatchObject({ ok: false, retryable: true, code: 63018 });
      expect((r as { configError?: true }).configError).toBeUndefined();
      expect((r as { rowFault?: true }).rowFault).toBeUndefined();
    }
  });

  it('an UNKNOWN 4xx code still defers — uncertainty fails in the recoverable direction', async () => {
    // the row-fault list is a conservative allow-list grown from evidence, not a full table:
    // a wrongly-deferred row is parked and recoverable, a wrongly-terminal one is destroyed
    fetchMock.mockResolvedValue(respond(400, { message: 'Something new', code: 29999 }));
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' });
    expect(r).toMatchObject({ ok: false, configError: true, code: 29999 });
    expect((r as { rowFault?: true }).rowFault).toBeUndefined();
  });

  it('classifies by WHOSE INPUT was wrong, not by HTTP semantics', async () => {
    // 4xx normally reads as "permanent client error", but everything row-shaped (E.164
    // recipient, consent, committed template, content present) is validated BEFORE the call —
    // so what is left in the request is environment. 5xx/429 stay transient and DO spend the
    // row's attempt budget, which is exactly what that budget is for.
    fetchMock.mockResolvedValue(respond(404, { message: 'Not Found', code: 20404 }));
    expect(await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' }))
      .toMatchObject({ configError: true });

    fetchMock.mockResolvedValue(respond(500, { message: 'Server Error' }));
    const transient = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' }, { maxAttempts: 1 });
    expect(transient).toMatchObject({ ok: false, retryable: true });
    expect((transient as { configError?: true }).configError).toBeUndefined();
  });

  it('retries a 429 up to the cap, then reports it retryable', async () => {
    fetchMock.mockResolvedValue(respond(429, { message: 'Too Many Requests' }));
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' }, { maxAttempts: 2 });
    expect(r).toMatchObject({ ok: false, retryable: true, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a network throw as retryable', async () => {
    fetchMock.mockRejectedValue(new Error('connection reset'));
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' }, { maxAttempts: 1 });
    expect(r).toMatchObject({ ok: false, retryable: true, error: 'connection reset' });
  });
});

describe('whatsappFailureAction — the defer/fail/retry policy', () => {
  // Extracted from the worker precisely so it CAN be pinned: notification-whatsapp-worker's
  // index.ts calls serve() and has no test harness, so a policy left inline there is a policy
  // nothing verifies. The worker now only switches on this.
  const base = { ok: false as const, error: 'x', attempts: 1 };

  it('parks config problems, terminates recipient problems, retries transient ones', () => {
    expect(whatsappFailureAction({ ...base, retryable: true, configError: true })).toBe('defer');
    expect(whatsappFailureAction({ ...base, retryable: false, rowFault: true, code: 21614 })).toBe('terminal');
    expect(whatsappFailureAction({ ...base, retryable: true })).toBe('retry');
    expect(whatsappFailureAction({ ...base, retryable: false })).toBe('terminal');
  });

  it('treats an unsubscribed recipient as a CONSENT event, not just a failed send', () => {
    // before the status webhook is live this is the only STOP signal we get; without recording
    // it the resolver keeps queueing messages to someone who opted out
    expect(whatsappFailureAction({ ...base, retryable: false, rowFault: true, code: 21610 }))
      .toBe('terminal_optout');
  });

  it('never lets a row fault be parked by a stray configError flag', () => {
    // rowFault is the stronger signal: a recipient problem is not fixed by editing an env var
    expect(whatsappFailureAction({
      ...base, retryable: false, rowFault: true, configError: true, code: 21610,
    })).toBe('terminal_optout');
  });
});
