import { Order_status } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

/**
 * C5 — SOTILGAN BUYURTMANI KARGO WEBHOOKI BEKOR QILARDI.
 *
 * `cancelStates` ro'yxatida `SOLD`/`PAID`/`PARTLY_PAID` YO'Q edi, ya'ni
 * ichki oqimda sotilgan buyurtma uchun kechikkan yoki takroriy `cancel`
 * webhooki statusni `CANCELLED` ga o'zgartirardi.
 *
 * `markByProvider` esa ATAYLAB status-only — kassani qaytarmaydi. Natijada
 * buyurtma "bekor qilingan" bo'lib turadi, pul esa sotuv sifatida kassada
 * qoladi: status va daftar JIMGINA ajraladi.
 *
 * ⚠️ Xato TASHLANMAYDI: chaqiruvchi bu chaqiruvni best-effort qiladi va
 * tashlangan xato jimgina yutilardi. Status o'zgartirilmaydi, hodisa esa
 * audit jurnaliga aniq sabab bilan yoziladi.
 */

function svc(status: Order_status) {
  const logs: Record<string, any>[] = [];
  const saved: Record<string, any>[] = [];
  const s = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService & Record<string, any>;

  Object.assign(s, {
    findById: jest.fn().mockResolvedValue({ id: '1001', status }),
    activityLog: {
      log: jest.fn((x: Record<string, any>) => {
        logs.push(x);
        return Promise.resolve(undefined);
      }),
    },
    logger: { warn: jest.fn() },
    dataSource: {
      createQueryRunner: () => ({
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          getRepository: () => ({
            save: jest.fn((x: Record<string, any>) => {
              saved.push(x);
              return Promise.resolve(x);
            }),
          }),
        },
      }),
    },
    custody: { createTrackingEvent: jest.fn() },
    syncOrderToSearch: jest.fn(),
    handleDbError: (e: unknown) => {
      throw e;
    },
  });
  return { s, logs, saved };
}

const cancel = (status: Order_status) => {
  const ctx = svc(status);
  return (ctx.s as any)
    .markByProvider({
      order_id: '1001',
      action: 'cancel',
      provider_slug: 'ldg',
    })
    .then((res: any) => ({ res, ...ctx }));
};

describe("C5 — kargo 'cancel' sotilgan buyurtmada RAD ETILADI", () => {
  it.each([Order_status.SOLD, Order_status.PAID, Order_status.PARTLY_PAID])(
    "⭐ %s holatida status O'ZGARMAYDI",
    async (status) => {
      const { res, saved } = await cancel(status);
      expect(res.data.refused).toBe(true);
      expect(res.data.status).toBe(status);
      // Tranzaksiya umuman boshlanmaydi — hech narsa saqlanmaydi.
      expect(saved).toHaveLength(0);
    },
  );

  it('⭐ audit jurnaliga ANIQ sabab yoziladi', async () => {
    /**
     * Jimgina o'tkazib yuborish ham xato bo'lardi: farqni odam ko'rib
     * qaror qilishi kerak (pulni teskari aylantirish kassa, kuryer qarzi
     * va operator daromadiga tegadi).
     */
    const { logs } = await cancel(Order_status.SOLD);
    expect(logs).toHaveLength(1);
    expect(logs[0].new_value.provider_action).toBe('cancel_refused');
    expect(String(logs[0].metadata.reason)).toMatch(/bekor qila olmaydi/);
  });

  it('⭐ xato TASHLANMAYDI — webhook yiqilmaydi', async () => {
    // Chaqiruvchi best-effort; tashlangan xato jimgina yutilardi.
    await expect(cancel(Order_status.SOLD)).resolves.toBeDefined();
  });

  it('allaqachon bekor qilingan — avvalgidek idempotent', async () => {
    const { res } = await cancel(Order_status.CANCELLED);
    expect(res.data.skipped).toBe(true);
    expect(res.data.refused).toBeUndefined();
  });

  it('⭐ WAITING holatida bekor qilish AVVALGIDEK ishlaydi', async () => {
    // Qo'riqchi faqat SOTILGAN holatlarni to'sadi, oddiy oqimga tegmaydi.
    const { res, saved } = await cancel(Order_status.WAITING);
    expect(res.data.refused).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe(Order_status.CANCELLED);
  });

  it("kargo 'sell' sotilgan buyurtmada avvalgidek idempotent", async () => {
    const ctx = svc(Order_status.SOLD);
    const res = await (ctx.s as any).markByProvider({
      order_id: '1001',
      action: 'sell',
    });
    expect(res.data.skipped).toBe(true);
  });
});
