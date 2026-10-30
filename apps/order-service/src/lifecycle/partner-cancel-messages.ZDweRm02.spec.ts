import { readFileSync } from 'fs';
import { join } from 'path';
import { RpcException } from '@nestjs/microservices';
import { CancelReason, Order_status, Roles } from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';
import {
  PARTNER_CANCEL_LEGACY_MESSAGES,
  keepPartnerCancelMessage,
} from './partner-cancel-messages';

/**
 * (ZDweRm02) `order.cancel` xabarlari Elchi foydalanuvchisi uchun o'zbekcha,
 * hamkor yo'lida (`partner:<id>`) esa eski matn: integration `rmqRequestStrict`
 * uni hamkorga o'zgarishsiz uzatadi va hamkor API matni — tashqi shartnoma.
 */
const makeService = (order: Record<string, unknown>) =>
  Object.assign(Object.create(OrderLifecycleService.prototype), {
    findById: jest.fn().mockResolvedValue(order),
  }) as OrderLifecycleService;

const cancelVia = (
  requester: { id: string; roles: string[] },
  order: Record<string, unknown>,
) =>
  keepPartnerCancelMessage(requester, () =>
    makeService(order).cancelOrder(requester, '7001', {
      reason: CancelReason.OTHER,
      comment: 'TEST',
    }),
  ).then(
    () => {
      throw new Error('RpcException kutilgan edi');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode: number;
        message: string;
      };
    },
  );

const staff = { id: '12', roles: [Roles.SUPERADMIN] };
const partner = { id: 'partner:3', roles: [Roles.SUPERADMIN] };

describe('ZDweRm02 — order.cancel xabarlari', () => {
  it('Elchi xodimi: waiting emas — o‘zbekcha, 400', async () => {
    await expect(
      cancelVia(staff, { status: Order_status.RECEIVED }),
    ).resolves.toEqual({
      statusCode: 400,
      message: 'Buyurtma topilmadi yoki kutilmoqda (waiting) holatida emas',
    });
  });

  it('hamkor: waiting emas — eski matn, status o‘sha (400)', async () => {
    await expect(
      cancelVia(partner, { status: Order_status.RECEIVED }),
    ).resolves.toEqual({
      statusCode: 400,
      message: 'Order not found or not in waiting status',
    });
  });

  it('hamkor: pochtasiz buyurtma — eski matn; xodim — o‘zbekcha', async () => {
    const order = { status: Order_status.WAITING, post_id: null };
    expect((await cancelVia(partner, order)).message).toBe('Order has no post');
    expect((await cancelVia(staff, order)).message).toBe(
      'Buyurtma hech qaysi pochtada emas',
    );
  });

  it('ro‘yxat kalitlari order-lifecycle’dagi haqiqiy matn (siljib ketmasin)', () => {
    const source = readFileSync(
      join(__dirname, 'order-lifecycle.service.ts'),
      'utf8',
    );
    for (const uzbek of Object.keys(PARTNER_CANCEL_LEGACY_MESSAGES)) {
      expect(source).toContain(`'${uzbek}'`);
    }
  });

  it('ro‘yxatda yo‘q xabar va RpcException bo‘lmagan xato tegilmaydi', async () => {
    const rpc = new RpcException({ statusCode: 409, message: 'Boshqa xato' });
    await expect(
      keepPartnerCancelMessage(partner, () => Promise.reject(rpc)),
    ).rejects.toBe(rpc);

    const plain = new Error('Market topilmadi');
    await expect(
      keepPartnerCancelMessage(partner, () => Promise.reject(plain)),
    ).rejects.toBe(plain);
  });

  it('muvaffaqiyatli javob o‘zgarishsiz qaytadi', async () => {
    await expect(
      keepPartnerCancelMessage(partner, () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });
});
