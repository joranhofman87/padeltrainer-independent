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
  it('treats 401 as RETRYABLE config, without burning in-request retries', async () => {
    // this is the live situation: SID and token belong to different accounts. Terminal here
    // would permanently fail every queued message over a fixable env var.
    fetchMock.mockResolvedValue(respond(401, { message: 'Authenticate', code: 20003 }));
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HX1' });
    expect(r).toMatchObject({ ok: false, retryable: true, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((r as { error: string }).error).toContain('20003');
  });

  it('treats a 400 as TERMINAL — retrying will never make it valid', async () => {
    fetchMock.mockResolvedValue(respond(400, { message: 'Invalid ContentSid', code: 21656 }));
    const r = await sendWhatsAppMessage(AUTH, { from: FROM, to: TO, contentSid: 'HXbad' });
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
