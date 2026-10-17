import { Cashbox_type, Source_type } from '@app/common';
import { FinanceServiceService } from '../finance-service.service';

/**
 * 2crjWf7v (veb qismi uchun) — kuryer kassasi tarixidagi pul topshirish
 * qatorida kuryerning bot kvitansiyasiga javobi (`payment_ack`) ko'rinadi:
 * menejer «Noto'g'ri» belgisini tarixda ko'radi.
 */
describe('2crjWf7v — kassa tarixida kvitansiya javobi', () => {
  const history = [
    { id: '47', source_type: Source_type.COURIER_PAYMENT, amount: 1000 },
    { id: '45', source_type: Source_type.COURIER_PAYMENT, amount: 1000 },
    { id: '44', source_type: Source_type.SELL, amount: 5000 },
    { id: '43', source_type: Source_type.COURIER_PAYMENT, amount: 2000 },
  ];

  const make = (cashboxType: Cashbox_type, query: jest.Mock) => {
    const self = Object.create(FinanceServiceService.prototype) as Record<
      string,
      unknown
    >;
    self.cashboxRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: '9',
        user_id: '26',
        cashbox_type: cashboxType,
      }),
    };
    self.historyRepo = {
      find: jest.fn().mockResolvedValue(history),
      query,
    };
    self.logger = { warn: jest.fn() };
    return self as unknown as FinanceServiceService;
  };

  type Result = {
    data: { cashboxHistory: Array<{ id: string; payment_ack?: unknown }> };
  };

  it('⭐ kuryer kassasi: topshirish qatorlariga confirmed / disputed / null, boshqa qatorlarga tegilmaydi', async () => {
    const query = jest.fn().mockResolvedValue([
      { payment_id: '47', ack: 'disputed' },
      { payment_id: '45', ack: 'confirmed' },
    ]);
    const service = make(Cashbox_type.FOR_COURIER, query);
    const res = (await service.getCashboxByUserId({
      id: '26',
      cashbox_type: Cashbox_type.FOR_COURIER,
    })) as unknown as Result;
    const byId = Object.fromEntries(
      res.data.cashboxHistory.map((row) => [row.id, row]),
    );
    expect(byId['47'].payment_ack).toBe('disputed');
    expect(byId['45'].payment_ack).toBe('confirmed');
    expect(byId['43'].payment_ack).toBeNull();
    expect('payment_ack' in byId['44']).toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ANY($1'), [
      ['47', '45', '43'],
    ]);
  });

  it('kuryer bo‘lmagan kassa — so‘rov yo‘q; so‘rov yiqilsa tarix o‘zgarishsiz', async () => {
    const query = jest.fn();
    const market = make(Cashbox_type.FOR_MARKET, query);
    await market.getCashboxByUserId({
      id: '37',
      cashbox_type: Cashbox_type.FOR_MARKET,
    });
    expect(query).not.toHaveBeenCalled();

    const failing = make(
      Cashbox_type.FOR_COURIER,
      jest.fn().mockRejectedValue(new Error('db down')),
    );
    const res = (await failing.getCashboxByUserId({
      id: '26',
      cashbox_type: Cashbox_type.FOR_COURIER,
    })) as unknown as Result;
    expect(res.data.cashboxHistory).toHaveLength(4);
  });
});
