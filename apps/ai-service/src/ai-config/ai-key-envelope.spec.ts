import { Logger } from '@nestjs/common';
import { AiKeyEnvelopeService } from './ai-key-envelope.service';
import { FAKE_KEY, sealForTest } from './ai-config-test-helpers';

/** be-brief §5.2 / §12 ai-key-envelope.spec. */
describe('AiKeyEnvelopeService', () => {
  const svc = new AiKeyEnvelopeService();
  const logSpies = (['log', 'warn', 'error', 'debug'] as const).map((m) =>
    jest.spyOn(Logger.prototype, m).mockImplementation(),
  );
  afterAll(() => jest.restoreAllMocks());

  it('view: kid = SHA-256(SPKI) 16 hex, alg, base64 SPKI', () => {
    const v = svc.view();
    expect(v.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(v.alg).toBe('RSA-OAEP-256+A256GCM');
    expect(Buffer.from(v.public_key_spki, 'base64').length).toBeGreaterThan(
      400,
    );
  });

  it('WebCrypto bilan muhrlangan konvert ochiladi', async () => {
    const env = await sealForTest(svc.view(), { api_key: FAKE_KEY, uid: '7' });
    expect(env.ek.length).toBeGreaterThanOrEqual(400);
    expect(env.ek.length).toBeLessThanOrEqual(700);
    expect(svc.open(env, '7')).toEqual({ ok: true, apiKey: FAKE_KEY });
  });

  it('noma’lum kid (qayta ishga tushgan) → STALE', async () => {
    const other = new AiKeyEnvelopeService();
    const env = await sealForTest(other.view(), {
      api_key: FAKE_KEY,
      uid: '7',
    });
    expect(svc.open(env, '7')).toEqual({
      ok: false,
      code: 'AI_KEY_WRAP_STALE',
    });
  });

  it('bit o‘zgargan ct/ek, boshqa uid, takroriy nonce → INVALID', async () => {
    const env = await sealForTest(svc.view(), { api_key: FAKE_KEY, uid: '7' });
    const flip = (s: string) => (s[5] === 'A' ? 'B' : 'A');
    const ctBad = {
      ...env,
      ct: env.ct.slice(0, 5) + flip(env.ct) + env.ct.slice(6),
    };
    const ekBad = {
      ...env,
      ek: env.ek.slice(0, 5) + flip(env.ek) + env.ek.slice(6),
    };
    expect(svc.open(ctBad, '7').ok).toBe(false);
    expect(svc.open(ekBad, '7').ok).toBe(false);
    expect(svc.open(env, '8')).toEqual({
      ok: false,
      code: 'AI_KEY_WRAP_INVALID',
    });

    const once = await sealForTest(svc.view(), {
      api_key: FAKE_KEY,
      uid: '7',
      nonce: 'n'.repeat(22),
    });
    expect(svc.open(once, '7').ok).toBe(true);
    const again = await sealForTest(svc.view(), {
      api_key: FAKE_KEY,
      uid: '7',
      nonce: 'n'.repeat(22),
    });
    expect(svc.open(again, '7')).toEqual({
      ok: false,
      code: 'AI_KEY_WRAP_INVALID',
    });
  });

  it('shakl xatolari → INVALID (tarmoqsiz, throw yo‘q)', async () => {
    const env = await sealForTest(svc.view(), { api_key: FAKE_KEY, uid: '7' });
    for (const bad of [
      null,
      'x',
      { ...env, v: 2 },
      { ...env, alg: 'RSA1_5' },
      { ...env, iv: 'short' },
      { ...env, ct: 'a+b/' + env.ct },
      { ...env, kid: 'ZZ' },
    ]) {
      expect(svc.open(bad, '7').ok).toBe(false);
    }
  });

  it('hech narsa logga yozilmaydi', async () => {
    const env = await sealForTest(svc.view(), { api_key: FAKE_KEY, uid: '7' });
    svc.open(env, '7');
    svc.open(env, '7');
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});
