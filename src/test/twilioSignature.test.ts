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
} from '../../supabase/functions/_shared/twilio-signature.ts';

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
