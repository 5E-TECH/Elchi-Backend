/**
 * Sotish / bekor qilish DTO kontrakti (Andijon E2E).
 *
 *   ZsPLevZZ — SellOrderRequestDto: `paidAmount` faqat 0 (eski klientlar
 *              regressiyasiz o'tadi), boshqa qiymat 400 (ilgari buyurtmani
 *              "to'landi" qilib, kassaga hech narsa yozmasdi).
 *   T0UGh8bL — CancelOrderRequestDto: `paidAmount` faqat 0 (eski UI shuni
 *              yuboradi), boshqa qiymat 400.
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
  it.each([105000, 1, -1])('⭐ paidAmount=%p — 400', async (paidAmount) => {
    const errors = await errorsFor(SellOrderRequestDto, {
      comment: 'Sotildi',
      paidAmount,
    });
    expect(errors.map((e) => e.property)).toContain('paidAmount');
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
    '⭐ paidAmount=%p — 400',
    async (paidAmount) => {
      const errors = await errorsFor(CancelOrderRequestDto, {
        comment: 'Mijoz olmadi',
        paidAmount,
      });
      expect(errors.map((e) => e.property)).toContain('paidAmount');
    },
  );

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
