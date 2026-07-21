// @vitest-environment node
// PR 9: X-Twilio-Signature verification. This endpoint runs verify_jwt = false — Twilio sends
// no Supabase JWT — so the signature IS the authentication and anyone on the internet can POST
// to it. A verifier that fails OPEN would let a forger fabricate delivery history or opt a
// number out with a single request, which is why the negative cases outnumber the positive one.
//
// The expected signature is computed with node:crypto (OpenSSL HMAC-SHA1), a genuinely
// independent implementation from the module's WebCrypto path — so this cross-checks the
// algorithm rather than comparing the code against itself.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyTwilioSignature,
  buildTwilioSignatureBase,
  isOptOutKeyword,
  optOutNumberFromPayload,
} from '../../supabase/functions/_shared/twilio-signature.ts';
import { TWILIO_CODE_UNSUBSCRIBED } from '../../supabase/functions/_shared/whatsapp-send.ts';

const TOKEN = 'the_auth_token_not_the_api_secret';
const URL_ = 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/twilio-whatsapp-webhook';

const PARAMS: Record<string, string> = {
  MessageSid: 'SM0123456789abcdef0123456789abcdef',
  MessageStatus: 'delivered',
  To: 'whatsapp:+31612345678',
  From: 'whatsapp:+3197010254321',
};

/** Independent oracle: Twilio signs url + each key+value in KEY-SORTED order, HMAC-SHA1, base64. */
const sign = (url: string, params: Record<string, string>, token = TOKEN) => {
  let s = url;
  for (const k of Object.keys(params).sort()) s += k + params[k];
  return createHmac('sha1', token).update(s).digest('base64');
};

describe('verifyTwilioSignature', () => {
  it('accepts a correctly signed request', async () => {
    const ok = await verifyTwilioSignature({
      authToken: TOKEN, url: URL_, params: PARAMS, signature: sign(URL_, PARAMS),
    });
    expect(ok).toBe(true);
  });

  it('is insensitive to param ORDER (the spec sorts by key)', async () => {
    const reordered: Record<string, string> = {
      From: PARAMS.From, MessageStatus: PARAMS.MessageStatus,
      To: PARAMS.To, MessageSid: PARAMS.MessageSid,
    };
    expect(buildTwilioSignatureBase(URL_, reordered)).toBe(buildTwilioSignatureBase(URL_, PARAMS));
    const ok = await verifyTwilioSignature({
      authToken: TOKEN, url: URL_, params: reordered, signature: sign(URL_, PARAMS),
    });
    expect(ok).toBe(true);
  });

  it('rejects a TAMPERED value — the forgery this actually defends against', async () => {
    const good = sign(URL_, PARAMS);
    // an attacker flips a delivered receipt into an opt-out-worthy failure
    const tampered = { ...PARAMS, MessageStatus: 'undelivered' };
    expect(await verifyTwilioSignature({
      authToken: TOKEN, url: URL_, params: tampered, signature: good,
    })).toBe(false);
  });

  it('rejects an ADDED parameter (extra fields are covered by the signature)', async () => {
    const good = sign(URL_, PARAMS);
    expect(await verifyTwilioSignature({
      authToken: TOKEN, url: URL_, params: { ...PARAMS, Body: 'STOP' }, signature: good,
    })).toBe(false);
  });

  it('rejects a signature made for a DIFFERENT url', async () => {
    expect(await verifyTwilioSignature({
      authToken: TOKEN, url: URL_, params: PARAMS,
      signature: sign('https://evil.example/functions/v1/twilio-whatsapp-webhook', PARAMS),
    })).toBe(false);
  });

  it('rejects a signature made with a different auth token', async () => {
    expect(await verifyTwilioSignature({
      authToken: TOKEN, url: URL_, params: PARAMS, signature: sign(URL_, PARAMS, 'wrong_token'),
    })).toBe(false);
  });

  it('FAILS CLOSED on missing token, missing signature and empty url', async () => {
    const good = sign(URL_, PARAMS);
    expect(await verifyTwilioSignature({ authToken: '', url: URL_, params: PARAMS, signature: good })).toBe(false);
    expect(await verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: PARAMS, signature: null })).toBe(false);
    expect(await verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: PARAMS, signature: '' })).toBe(false);
    expect(await verifyTwilioSignature({ authToken: TOKEN, url: '', params: PARAMS, signature: good })).toBe(false);
  });

  it('rejects a garbage signature rather than throwing', async () => {
    expect(await verifyTwilioSignature({
      authToken: TOKEN, url: URL_, params: PARAMS, signature: 'not-base64-!!!',
    })).toBe(false);
  });
});

describe('isOptOutKeyword', () => {
  it('recognizes the opt-out keywords regardless of case/whitespace', () => {
    for (const w of ['STOP', 'stop', '  Stop  ', 'STOPALL', 'unsubscribe', 'CANCEL', 'end', 'quit']) {
      expect(isOptOutKeyword(w)).toBe(true);
    }
  });

  it('does NOT treat a sentence containing "stop" as an opt-out', () => {
    // over-matching would silently revoke consent for someone who never asked to leave
    expect(isOptOutKeyword('stop by at 9?')).toBe(false);
    expect(isOptOutKeyword('please stop')).toBe(false);
    expect(isOptOutKeyword('Bedankt!')).toBe(false);
    expect(isOptOutKeyword('')).toBe(false);
    expect(isOptOutKeyword(null)).toBe(false);
    expect(isOptOutKeyword(undefined)).toBe(false);
  });
});

describe('optOutNumberFromPayload — which field holds the USER, per payload shape', () => {
  const OUR_SENDER = 'whatsapp:+3197010254321';
  const USER = 'whatsapp:+31612345678';

  it('inbound STOP: the user is the SENDER', () => {
    expect(optOutNumberFromPayload({ From: USER, To: OUR_SENDER, Body: 'STOP' }))
      .toBe('+31612345678');
  });

  it('status callback 21610: the user is the RECIPIENT — never our own sender', () => {
    // THE bug this function exists to prevent. On an outbound status callback From is OUR
    // platform number; reading it would revoke our own sender and silently discard the real
    // withdrawal, while the webhook 200s and a row lands in the delivery log as if fine.
    const n = optOutNumberFromPayload({
      MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '21610',
      From: OUR_SENDER, To: USER,
    });
    expect(n).toBe('+31612345678');
    expect(n).not.toBe('+3197010254321');
  });

  it('the code it keys on matches the send helper, so the two cannot drift', () => {
    expect(TWILIO_CODE_UNSUBSCRIBED).toBe(21610);
  });

  it('does NOT treat other failure codes as consent withdrawal', () => {
    // 63024/21614 mean undeliverable, not "asked us to stop" — revoking on those would opt
    // people out for owning the wrong handset
    for (const ErrorCode of ['63024', '21614', '63032', '30008']) {
      expect(optOutNumberFromPayload({
        MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode, From: OUR_SENDER, To: USER,
      })).toBeNull();
    }
  });

  it('returns null for an ordinary delivery callback and an ordinary inbound message', () => {
    expect(optOutNumberFromPayload({
      MessageSid: 'SM1', MessageStatus: 'delivered', From: OUR_SENDER, To: USER,
    })).toBeNull();
    expect(optOutNumberFromPayload({ From: USER, To: OUR_SENDER, Body: 'tot morgen!' })).toBeNull();
    expect(optOutNumberFromPayload({})).toBeNull();
  });

  it('returns null when 21610 arrives with no To to act on', () => {
    expect(optOutNumberFromPayload({
      MessageSid: 'SM1', MessageStatus: 'failed', ErrorCode: '21610', From: OUR_SENDER,
    })).toBeNull();
  });
});
