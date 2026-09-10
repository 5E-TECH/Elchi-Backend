import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

/**
 * G3/G4 — tashqi tizimga status signali.
 *
 * Bu spec ikki narsani qulflaydi:
 *   1. `resolveSyncAction` — qaysi status o'zgarishi signal chiqarishi kerak.
 *      Avval CANCELLED_SENT va rollback yo'llari e'tibordan chetda qolgan edi.
 *   2. `queueExternalStatusSync` — hamkor webhooki `operator` prefiksiga
 *      BOG'LIQ EMAS. Bu eng muhim invariant: partner buyurtmalarida `operator`
 *      boshqacha bo'ladi, shuning uchun eski `external_` sharti hamkor
 *      signalini jimgina yo'q qilardi.
 *
 * To'liq rollback oqimi (tranzaksiya + commit) bu yerda simulyatsiya
 * qilinmaydi — u pilot qabul mezoni №5 orqali qo'lda tekshiriladi.
 */
function makeService(integrationSend: jest.Mock) {
  return new OrderLifecycleService(
    {} as any, // dataSource
    {} as any, // orderRepo
    {} as any, // orderItemRepo
    {} as any, // orderTrackingRepo
    {} as any, // orderCustodyEventRepo
    {} as any, // transferBatchRepo
    {} as any, // searchClient
    {} as any, // identityClient
    {} as any, // catalogClient
    {} as any, // financeClient
    { send: integrationSend } as any, // integrationClient
    {} as any, // branchClient
    {} as any, // fileClient
    {} as any, // outbox
    { log: jest.fn().mockResolvedValue(undefined) } as any, // activityLog
    {} as any, // lookup
  );
}

describe('resolveSyncAction — qaysi o‘zgarish signal chiqaradi', () => {
  const svc: any = makeService(jest.fn());
  const resolve = (from: Order_status, to: Order_status) =>
    svc.resolveSyncAction(from, to);

  it('SOLD -> "sold"', () => {
    expect(resolve(Order_status.WAITING, Order_status.SOLD)).toBe('sold');
  });

  it('CANCELLED -> "canceled"', () => {
    expect(resolve(Order_status.WAITING, Order_status.CANCELLED)).toBe(
      'canceled',
    );
  });

  // G4-sinfi: avval null qaytarardi -> hamkorga HECH QANDAY signal ketmasdi va
  // buyurtma u tomonda kutilmoqdada qolib ketardi.
  it('CANCELLED_SENT -> "canceled" (avval signal chiqmasdi)', () => {
    expect(resolve(Order_status.WAITING, Order_status.CANCELLED_SENT)).toBe(
      'canceled',
    );
  });

  // G4: posilka egasiga qaytdi -> tashqi tizim uchun bekor qilish.
  it('RETURNED_TO_MARKET -> "canceled" (avval signal chiqmasdi)', () => {
    expect(
      resolve(Order_status.WAITING, Order_status.RETURNED_TO_MARKET),
    ).toBe('canceled');
  });

  // G4: kuryer yetkaza olmadi -> TERMINAL EMAS, buyurtma hamon kutmoqda.
  // Avval signal chiqmasdi va hamkor tomonda buyurtma "yo'lda"da qotib qolardi.
  it('WAITING_CUSTOMER -> "waiting" (terminal emas)', () => {
    expect(
      resolve(Order_status.ON_THE_ROAD, Order_status.WAITING_CUSTOMER),
    ).toBe('waiting');
  });

  it('PAID va PARTLY_PAID -> "paid"', () => {
    expect(resolve(Order_status.WAITING, Order_status.PAID)).toBe('paid');
    expect(resolve(Order_status.WAITING, Order_status.PARTLY_PAID)).toBe(
      'paid',
    );
  });

  // G3 uchun kalit: terminal holatdan WAITING ga qaytish = rollback.
  it.each([
    Order_status.SOLD,
    Order_status.PAID,
    Order_status.PARTLY_PAID,
    Order_status.CANCELLED,
    Order_status.CLOSED,
  ])('%s -> WAITING = "rollback"', (from) => {
    expect(resolve(from, Order_status.WAITING)).toBe('rollback');
  });

  it('RECEIVED -> WAITING = "waiting" (rollback EMAS)', () => {
    expect(resolve(Order_status.RECEIVED, Order_status.WAITING)).toBe(
      'waiting',
    );
  });

  it('signal talab qilmaydigan o‘zgarish -> null', () => {
    expect(resolve(Order_status.NEW, Order_status.RECEIVED)).toBeNull();
  });
});

describe('queueExternalStatusSync — hamkor webhooki', () => {
  const partnerCalls = (send: jest.Mock) =>
    send.mock.calls.filter(
      ([pattern]) => pattern?.cmd === 'integration.partner.webhook.enqueue',
    );
  const legacyCalls = (send: jest.Mock) =>
    send.mock.calls.filter(
      ([pattern]) => pattern?.cmd === 'integration.sync.enqueue',
    );

  it('external_id bor -> hamkor webhooki navbatga qo‘yiladi', async () => {
    const send = jest.fn(() => of({}));
    const svc: any = makeService(send);

    await svc.queueExternalStatusSync(
      { id: '900', external_id: 'ord-9', operator: 'courier_5', paid_amount: 0 },
      'rollback',
      Order_status.SOLD,
      Order_status.WAITING,
    );

    const calls = partnerCalls(send);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        order_id: '900',
        external_order_id: 'ord-9',
        action: 'rollback',
        old_status: Order_status.SOLD,
        new_status: Order_status.WAITING,
      }),
    );
  });

  // INVARIANT: hamkor yo'li `operator` qiymatiga bog'liq bo'lmasligi kerak.
  it('operator "external_" bilan boshlanmasa ham hamkor webhooki ketadi', async () => {
    const send = jest.fn(() => of({}));
    const svc: any = makeService(send);

    await svc.queueExternalStatusSync(
      { id: '901', external_id: 'ord-10', operator: 'manager_3', paid_amount: 0 },
      'canceled',
      Order_status.WAITING,
      Order_status.CANCELLED,
    );

    expect(partnerCalls(send)).toHaveLength(1);
    // Eski ExternalIntegration yo'li esa `external_` shartiga bog'liq qoladi.
    expect(legacyCalls(send)).toHaveLength(0);
  });

  it('external_id yo‘q -> hech qanday signal chiqmaydi', async () => {
    const send = jest.fn(() => of({}));
    const svc: any = makeService(send);

    await svc.queueExternalStatusSync(
      { id: '902', external_id: null, operator: 'courier_5', paid_amount: 0 },
      'sold',
      Order_status.WAITING,
      Order_status.SOLD,
    );

    expect(send).not.toHaveBeenCalled();
  });

  it('sold -> yig‘ilgan summa (cod_collected) uzatiladi', async () => {
    const send = jest.fn(() => of({}));
    const svc: any = makeService(send);

    await svc.queueExternalStatusSync(
      {
        id: '903',
        external_id: 'ord-11',
        operator: 'courier_5',
        paid_amount: 250000,
      },
      'sold',
      Order_status.WAITING,
      Order_status.SOLD,
    );

    expect(partnerCalls(send)[0][1]).toEqual(
      expect.objectContaining({ cod_collected: 250000 }),
    );
  });
});
