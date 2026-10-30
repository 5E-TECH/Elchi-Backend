import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Order_status } from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderServiceController } from '../order-service.controller';

/**
 * T6 — `order.payment_reversal.apply`: to'langan qismni kamaytiradi, holat
 * faqat to'lov qaytarilishi qirralari bilan, hamkorga holat sinxroni
 * YUBORILMAYDI (`suppressExternalSync`). CLOSED — tegilmaydi.
 */
describe('T6 applyPaymentReversal', () => {
  const make = (status: Order_status) => {
    const service = Object.create(
      OrderLifecycleService.prototype,
    ) as OrderLifecycleService;
    const updateFull = jest.fn().mockResolvedValue({});
    Object.assign(service, {
      findById: jest.fn().mockResolvedValue({ id: '5', status }),
      updateFull,
    });
    return { service, updateFull };
  };

  it('⭐ PAID → PARTLY_PAID: updateFull paymentReversal + suppressExternalSync', async () => {
    const { service, updateFull } = make(Order_status.PAID);
    const res = await service.applyPaymentReversal({
      order_id: '5',
      paid_amount: 150_000,
      status: Order_status.PARTLY_PAID,
    });
    expect(updateFull).toHaveBeenCalledWith(
      '5',
      { paid_amount: 150_000, status: Order_status.PARTLY_PAID },
      undefined,
      undefined,
      { paymentReversal: true, suppressExternalSync: true },
    );
    expect(res).toMatchObject({ data: { skipped: false } });
  });

  it('CLOSED — o`zgartirilmaydi; noto`g`ri holat → 400', async () => {
    const { service, updateFull } = make(Order_status.CLOSED);
    const res = await service.applyPaymentReversal({
      order_id: '5',
      paid_amount: 0,
      status: Order_status.SOLD,
    });
    expect(updateFull).not.toHaveBeenCalled();
    expect(res).toMatchObject({ data: { skipped: true } });
    await expect(
      service.applyPaymentReversal({
        order_id: '5',
        paid_amount: 0,
        status: Order_status.PAID,
      }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
  });
});

describe('T6 syncExternalAfterUpdate — hamkor holat sinxroni', () => {
  const make = () => {
    const service = Object.create(
      OrderLifecycleService.prototype,
    ) as OrderLifecycleService;
    const queue = jest.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      resolveSyncAction: jest.fn(() => 'paid'),
      queueExternalStatusSync: queue,
    });
    const run = (options?: { suppressExternalSync?: boolean }) =>
      (
        service as unknown as {
          syncExternalAfterUpdate: (
            updated: { status: Order_status },
            old: Order_status,
            options?: { suppressExternalSync?: boolean },
          ) => void;
        }
      ).syncExternalAfterUpdate(
        { status: Order_status.SOLD },
        Order_status.PAID,
        options,
      );
    return { run, queue };
  };

  it('⭐ oddiy o`zgarish — hamkorga yuboriladi; suppressExternalSync — yuborilmaydi', () => {
    const plain = make();
    plain.run();
    expect(plain.queue).toHaveBeenCalledTimes(1);
    const suppressed = make();
    suppressed.run({ suppressExternalSync: true });
    expect(suppressed.queue).not.toHaveBeenCalled();
  });
});

describe('T6 order.update_normalized — suppress_external_sync', () => {
  const make = () => {
    const updateFull = jest.fn().mockResolvedValue({});
    const rmq = { ack: jest.fn(), nack: jest.fn(), nackForError: jest.fn() };
    const controller = new OrderServiceController(
      rmq as never,
      { normalizeUpdatePayload: (dto: unknown) => dto } as never,
      {} as never,
      {} as never,
      {} as never,
      { updateFull } as never,
      {} as never,
      {} as never,
    );
    const ctx = {
      getChannelRef: () => ({ ack: jest.fn(), nack: jest.fn() }),
      getMessage: () => ({}),
    };
    return { controller, updateFull, ctx };
  };

  it('⭐ bayroq bilan — updateFull suppressExternalSync; bayroqsiz — 3 argument (avvalgidek)', async () => {
    const a = make();
    await a.controller.updateNormalized(
      { id: '5', dto: { paid_amount: 1 }, suppress_external_sync: true },
      a.ctx as never,
    );
    expect(a.updateFull).toHaveBeenCalledWith(
      '5',
      { paid_amount: 1 },
      undefined,
      undefined,
      { suppressExternalSync: true },
    );
    const b = make();
    await b.controller.updateNormalized(
      { id: '5', dto: { paid_amount: 1 } },
      b.ctx as never,
    );
    expect(b.updateFull).toHaveBeenCalledWith(
      '5',
      { paid_amount: 1 },
      undefined,
    );
  });

  it('gateway bayroqni hech qachon yubormaydi (tashqi chaqiruvchi o`rnata olmaydi)', () => {
    const dir = join(__dirname, '..', '..', '..', 'api-gateway', 'src');
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(d, e.name))
          : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')
            ? [join(d, e.name)]
            : [],
      );
    const offenders = walk(dir).filter((file) =>
      /suppress_external_sync|suppressExternalSync/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
