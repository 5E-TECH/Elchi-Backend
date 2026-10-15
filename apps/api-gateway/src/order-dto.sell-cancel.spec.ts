/**
 * Sotish / bekor qilish DTO kontrakti (Andijon E2E).
 *
 *   T0UGh8bL — SellOrderRequestDto: `paidAmount` endi QABUL qilinadi
 *              (ZsPLevZZ (a) yo'li — servis kassa/settlement oyoqlarini
 *              yozadi): butun, manfiy bo'lmagan son; kasr / manfiy — 400.
 *              `paidAmount: 0` (eski klientlar) — o'tadi.
 *   T0UGh8bL / smioRTUg — CancelOrderRequestDto: `paidAmount` faqat 0 (eski
 *              UI shuni yuboradi), boshqa qiymat 400 ANIQ xabar bilan.
 *   PUvKXWVw — `reason` yopiq ro'yxatdan.
 *
 * Global ValidationPipe bilan bir xil sozlama: whitelist + forbidNonWhitelisted.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CancelReason } from '@app/common';
import {
  CancelOrderRequestDto,
  SellOrderRequestDto,
} from './dto/order.swagger.dto';

const errorsFor = async (
  cls: typeof SellOrderRequestDto | typeof CancelOrderRequestDto,
  body: Record<string, unknown>,
) =>
  validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('SellOrderRequestDto', () => {
  it.each([[105000], [1], ['105 000'], ['105000']])(
    '⭐ T0UGh8bL TC3: paidAmount=%p — qabul qilinadi (chegarasi servisda)',
    async (paidAmount) => {
      expect(
        await errorsFor(SellOrderRequestDto, {
          comment: 'Sotildi',
          extraCost: 0,
          paidAmount,
        }),
      ).toHaveLength(0);
    },
  );

  it.each([
    [-1, "paidAmount manfiy bo'lishi mumkin emas"],
    [1500.5, "paidAmount butun son (so'm) bo'lishi kerak"],
    ['abc', "paidAmount butun son (so'm) bo'lishi kerak"],
  ])('paidAmount=%p — 400 (%s)', async (paidAmount, message) => {
    const errors = await errorsFor(SellOrderRequestDto, {
      comment: 'Sotildi',
      paidAmount,
    });
    const error = errors.find((e) => e.property === 'paidAmount');
    expect(error).toBeDefined();
    expect(Object.values(error?.constraints ?? {})).toContain(message);
  });

  it('UI yuboradigan tana (comment/extraCost) — o`tadi', async () => {
    expect(
      await errorsFor(SellOrderRequestDto, { comment: 'x', extraCost: 0 }),
    ).toHaveLength(0);
  });

  it('⭐ regressiya: eski klient {paidAmount: 0} — o`tadi (ZsPLevZZ TC 2)', async () => {
    expect(
      await errorsFor(SellOrderRequestDto, {
        comment: 'x',
        extraCost: 0,
        paidAmount: 0,
      }),
    ).toHaveLength(0);
  });

  it('multipart: paidAmount "0" satr — o`tadi', async () => {
    expect(
      await errorsFor(SellOrderRequestDto, { comment: 'x', paidAmount: '0' }),
    ).toHaveLength(0);
  });
});

describe('CancelOrderRequestDto', () => {
  it('eski UI tanasi {comment, extraCost: 0, paidAmount: 0} — o`tadi', async () => {
    expect(
      await errorsFor(CancelOrderRequestDto, {
        comment: 'Mijoz olmadi',
        extraCost: 0,
        paidAmount: 0,
      }),
    ).toHaveLength(0);
  });

  it('multipart: paidAmount "0" satr — o`tadi', async () => {
    expect(
      await errorsFor(CancelOrderRequestDto, {
        comment: 'Mijoz olmadi',
        paidAmount: '0',
      }),
    ).toHaveLength(0);
  });

  it.each([[100], [99999], ['100']])(
    '⭐ smioRTUg: paidAmount=%p — 400 aniq xabar bilan',
    async (paidAmount) => {
      const errors = await errorsFor(CancelOrderRequestDto, {
        comment: 'Mijoz olmadi',
        paidAmount,
      });
      const error = errors.find((e) => e.property === 'paidAmount');
      expect(error).toBeDefined();
      expect(Object.values(error?.constraints ?? {})).toContain(
        "paidAmount bekor qilishda qabul qilinmaydi — faqat 0 bo'lishi mumkin",
      );
    },
  );

  it('smioRTUg: paidAmount yuborilmasa ham — o`tadi (maydon ixtiyoriy)', async () => {
    expect(
      await errorsFor(CancelOrderRequestDto, {
        reason: CancelReason.CUSTOMER_REFUSED,
        extraCost: 0,
      }),
    ).toHaveLength(0);
  });

  it.each(Object.values(CancelReason))('reason=%s — o`tadi', async (reason) => {
    expect(
      await errorsFor(CancelOrderRequestDto, { reason, comment: 'izoh' }),
    ).toHaveLength(0);
  });

  it('ro`yxatda yo`q reason — 400', async () => {
    const errors = await errorsFor(CancelOrderRequestDto, { reason: 'BORED' });
    expect(errors.map((e) => e.property)).toContain('reason');
  });
});
