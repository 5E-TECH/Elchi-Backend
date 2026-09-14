import { UnauthorizedException } from '@nestjs/common';
import { computeHmacSignature } from './hmac';
import {
  WebhookSignatureGuard,
  type WebhookSecret,
} from './webhook-signature.guard';

/**
 * AUDIT S7. Imzoning o'zi replay'dan himoya qilmaydi: ushlangan haqiqiy
 * so'rov baytma-bayt qayta yuborilsa, imzo ham yaroqli bo'lib qolaveradi.
 * Vaqt tamg'asi sozlangan bo'lsa, eski so'rov rad etiladi — va sarlavhaning
 * O'ZI yo'q bo'lsa ham rad etiladi (aks holda hujumchi uni olib tashlardi).
 */
class TestGuard extends WebhookSignatureGuard {
  constructor(private readonly cfg: WebhookSecret) {
    super();
  }
  resolveSecret(): WebhookSecret {
    return this.cfg;
  }
}

const SECRET = 'shh';
const BODY = Buffer.from('{"event":"delivered"}');

function contextFor(headers: Record<string, string>) {
  const req = {
    rawBody: BODY,
    headers,
    originalUrl: '/webhook',
    ip: '1.2.3.4',
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

describe('WebhookSignatureGuard — replay himoyasi', () => {
  const signature = computeHmacSignature(BODY, SECRET);

  it('vaqt tamg`asi sozlanmagan bo`lsa avvalgidek ishlaydi', async () => {
    const guard = new TestGuard({ current: SECRET });
    await expect(
      guard.canActivate(contextFor({ 'x-signature': signature })),
    ).resolves.toBe(true);
  });

  it('yangi vaqt tamg`asini qabul qiladi', async () => {
    const guard = new TestGuard({
      current: SECRET,
      timestampHeader: 'x-timestamp',
    });
    await expect(
      guard.canActivate(
        contextFor({
          'x-signature': signature,
          'x-timestamp': String(Date.now()),
        }),
      ),
    ).resolves.toBe(true);
  });

  it('soniyadagi vaqt tamg`asini ham tushunadi', async () => {
    const guard = new TestGuard({
      current: SECRET,
      timestampHeader: 'x-timestamp',
    });
    await expect(
      guard.canActivate(
        contextFor({
          'x-signature': signature,
          'x-timestamp': String(Math.floor(Date.now() / 1000)),
        }),
      ),
    ).resolves.toBe(true);
  });

  it('eski (qayta yuborilgan) so`rovni rad etadi', async () => {
    const guard = new TestGuard({
      current: SECRET,
      timestampHeader: 'x-timestamp',
      maxSkewMs: 60_000,
    });
    await expect(
      guard.canActivate(
        contextFor({
          'x-signature': signature,
          'x-timestamp': String(Date.now() - 10 * 60_000),
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('sarlavha sozlangan, lekin yuborilmagan bo`lsa rad etadi', async () => {
    const guard = new TestGuard({
      current: SECRET,
      timestampHeader: 'x-timestamp',
    });
    await expect(
      guard.canActivate(contextFor({ 'x-signature': signature })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('noto`g`ri imzoda vaqt tamg`asiga yetib ham bormaydi', async () => {
    const guard = new TestGuard({
      current: SECRET,
      timestampHeader: 'x-timestamp',
    });
    await expect(
      guard.canActivate(
        contextFor({
          'x-signature': 'deadbeef',
          'x-timestamp': String(Date.now()),
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });
});
