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

  describe('menejer: GET /finance/cashbox/user/:id (findCashboxByUser)', () => {
    type Paged = {
      data: { history: Array<{ id: string; payment_ack?: unknown }> };
    };
    const acks = () =>
      jest.fn().mockResolvedValue([
        { payment_id: '47', ack: 'disputed' },
        { payment_id: '45', ack: 'confirmed' },
      ]);
    const byId = (res: Paged) =>
      Object.fromEntries(res.data.history.map((row) => [row.id, row]));

    it('⭐ cashbox_type=couriers sahifalangan tarixda ham payment_ack bor', async () => {
      const query = acks();
      const service = make(Cashbox_type.FOR_COURIER, query);
      (
        service as unknown as { historyRepo: Record<string, unknown> }
      ).historyRepo.findAndCount = jest
        .fn()
        .mockResolvedValue([history, history.length]);
      const res = (await service.findCashboxByUser({
        user_id: '26',
        cashbox_type: Cashbox_type.FOR_COURIER,
        with_history: true,
      } as never)) as unknown as Paged;
      const rows = byId(res);
      expect(rows['47'].payment_ack).toBe('disputed');
      expect(rows['45'].payment_ack).toBe('confirmed');
      expect(rows['43'].payment_ack).toBeNull();
      expect('payment_ack' in rows['44']).toBe(false);
    });

    it('kassa turi berilmasa — faqat kuryer kassasidagi topshirish qatorlari; filial qatoriga tegilmaydi', async () => {
      const query = acks();
      const service = make(Cashbox_type.FOR_COURIER, query);
      const courier = { cashbox_type: Cashbox_type.FOR_COURIER };
      const rows = [
        {
          id: '47',
          source_type: Source_type.COURIER_PAYMENT,
          cashbox: courier,
        },
        { id: '44', source_type: Source_type.SELL, cashbox: courier },
        {
          id: '48',
          source_type: Source_type.COURIER_PAYMENT,
          cashbox: { cashbox_type: Cashbox_type.MAIN },
        },
      ];
      const qb: Record<string, jest.Mock> = {};
      for (const m of [
        'innerJoinAndSelect',
        'where',
        'andWhere',
        'orderBy',
        'skip',
        'take',
      ])
        qb[m] = jest.fn(() => qb);
      qb.getManyAndCount = jest.fn().mockResolvedValue([rows, rows.length]);
      const self = service as unknown as Record<
        string,
        Record<string, unknown>
      >;
      self.cashboxRepo.find = jest.fn().mockResolvedValue([]);
      self.historyRepo.createQueryBuilder = jest.fn(() => qb);
      const res = (await service.findCashboxByUser({
        user_id: '26',
        with_history: true,
      } as never)) as unknown as Paged;
      const out = byId(res);
      expect(out['47'].payment_ack).toBe('disputed');
      expect('payment_ack' in out['44']).toBe(false);
      expect('payment_ack' in out['48']).toBe(false);
      expect(query).toHaveBeenCalledWith(expect.any(String), [['47']]);
    });
  });
});
