import { OrderSettlementService } from './settlement/order-settlement.service';
import { SettlementStatus } from '@app/common';
import { OrderSettlement } from './entities/order-settlement.entity';

/**
 * FIFO settlement allocation: a lump-sum payment settles the oldest unsettled
 * orders whole, advances their settlement status, and posts cashbox movements
 * (captured here via the outbox mock). Whole-order allocation — an order is only
 * settled when the remaining lump-sum covers its full leg amount.
 */
/** `advanceSettlement` javobining tekshiriladigan qismi. */
type AdvanceResult = {
  data: { settled_order_ids: string[]; allocated: number; leftover: number };
};

describe('OrderSettlementService settlement (FIFO)', () => {
  function makeService(rows: Partial<OrderSettlement>[]) {
    // Mutable in-memory settlement rows.
    const store = rows.map((r, i) => ({
      id: String(i + 1),
      status: SettlementStatus.PENDING,
      courier_amount: 0,
      branch_amount: 0,
      market_amount: 0,
      isDeleted: false,
      ...r,
    })) as OrderSettlement[];

    const settlementRepo = {
      find: jest.fn(async (opts: any) => {
        const where = opts?.where ?? {};
        return store
          .filter((row) =>
            Object.entries(where).every(([k, v]) => (row as any)[k] === v),
          )
          .sort((a, b) => Number(a.id) - Number(b.id));
      }),
      update: jest.fn(async (criteria: any, patch: any) => {
        const row = store.find((r) => r.id === criteria.id);
        if (row) Object.assign(row, patch);
        return { affected: row ? 1 : 0 };
      }),
      createQueryBuilder: jest.fn(),
    };

    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn(() => settlementRepo),
      },
    };

    const outbox = { enqueue: jest.fn() };

    // OrderSettlementService(dataSource, orderSettlementRepo, financeClient).
    // The FIFO advance path is state-only, so financeClient is never touched.
    const service = new OrderSettlementService(
      { createQueryRunner: jest.fn(() => queryRunner) } as any, // dataSource
      settlementRepo as any, // orderSettlementRepo
      {} as any, // financeClient
    );

    return { service, store, outbox, settlementRepo };
  }

  // The live settlement path is the STATE-ONLY advance: the finance payment
  // endpoints move the cashbox, then enqueue order.settlement.advance via the
  // outbox (Faza 2a). The advance runs the same FIFO allocation but posts NO
  // cashbox legs. The legacy cashbox-posting settle* path is retired (Faza 2b).
  it('advance courier→branch settles oldest orders whole until the lump-sum runs out (state-only)', async () => {
    const { service, store, outbox } = makeService([
      { order_id: '101', courier_id: '7', branch_id: '10', courier_amount: 60 },
      { order_id: '102', courier_id: '7', branch_id: '10', courier_amount: 50 },
      { order_id: '103', courier_id: '7', branch_id: '10', courier_amount: 40 },
    ]);

    const res: any = await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 120,
      requester_id: '1',
    });

    // 60 + 50 = 110 settled (whole orders); 40 doesn't fit in remaining 10.
    expect(res.data.settled_order_ids).toEqual(['101', '102']);
    expect(res.data.allocated).toBe(110);
    expect(res.data.leftover).toBe(10);
    expect(store[0].status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(store[1].status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(store[2].status).toBe(SettlementStatus.PENDING);
    // State-only: the cashbox was already moved by the finance payment path.
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  /**
   * HQ sotuvida filial bo'g'ini YO'Q: kuryer naqdni to'g'ridan-to'g'ri HQ'ga
   * topshiradi. Ilgari bunday qatorlar `COURIER_SETTLED` da qotib qolardi va
   * `hq_to_market` (u `BRANCH_SETTLED` dan boshlanadi) ularni hech qachon
   * ko'rmasdi — ya'ni HQ sotuvlari uchun marketga hisob-kitob ledgeri abadiy
   * ochiq turardi (audit M1).
   */
  it('filialsiz (HQ) buyurtma kuryer topshirganda darhol BRANCH_SETTLED bo`ladi', async () => {
    const { service, store } = makeService([
      { order_id: '301', courier_id: '7', branch_id: null, courier_amount: 60 },
      { order_id: '302', courier_id: '7', branch_id: '10', courier_amount: 40 },
    ]);

    const res: any = await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 100,
      requester_id: '1',
    });

    expect(res.data.settled_order_ids).toEqual(['301', '302']);
    // Filialsiz — pul allaqachon HQ'da.
    expect(store[0].status).toBe(SettlementStatus.BRANCH_SETTLED);
    // Filialli — hali filialda, HQ'ga topshirilishi kerak.
    expect(store[1].status).toBe(SettlementStatus.COURIER_SETTLED);
  });

  it('advance branch→HQ only advances COURIER_SETTLED orders (state-only)', async () => {
    const { service, store, outbox } = makeService([
      {
        order_id: '201',
        branch_id: '10',
        branch_amount: 30,
        status: SettlementStatus.COURIER_SETTLED,
      },
      {
        order_id: '202',
        branch_id: '10',
        branch_amount: 30,
        status: SettlementStatus.PENDING, // not yet courier-settled → skipped
      },
    ]);

    const res: any = await service.advanceSettlement({
      level: 'branch_to_hq',
      match_value: '10',
      amount: 100,
      requester_id: '1',
    });

    expect(res.data.settled_order_ids).toEqual(['201']);
    expect(store[0].status).toBe(SettlementStatus.BRANCH_SETTLED);
    // 202 was only PENDING (courier hasn't settled it) → untouched by branch→HQ.
    expect(store[1].status).toBe(SettlementStatus.PENDING);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('strict FIFO: does NOT skip an older non-fitting order to settle a newer one', async () => {
    const { service, store } = makeService([
      { order_id: '101', courier_id: '7', courier_amount: 100 }, // oldest, too big
      { order_id: '102', courier_id: '7', courier_amount: 30 }, // newer, would fit
    ]);

    const res: any = await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 50, // covers 102 but NOT the older 101
      requester_id: '1',
    });

    // Strict oldest-first: 101 doesn't fit → STOP. 102 must NOT leapfrog it.
    expect(res.data.settled_order_ids).toEqual([]);
    expect(res.data.allocated).toBe(0);
    expect(res.data.leftover).toBe(50);
    expect(store[0].status).toBe(SettlementStatus.PENDING);
    expect(store[1].status).toBe(SettlementStatus.PENDING);
  });

  /**
   * ⭐ JONLI HOLAT (BeePost↔Elchi E2E, Andijon) — QO'SHIMCHA XARAJAT KREDITI.
   *
   * Kuryer kassasi: +30 000 +110 000 +70 000 = 210 000 kirim, so'ng BEKOR
   * qilingan buyurtmaga yozilgan −5 000 qo'shimcha xarajat → qoldiq 205 000.
   * Ledger esa 210 000 talab qilardi: FIFO birinchi ikkitasini yopib,
   * uchinchisiga AYNAN 5 000 so'm yetmay to'xtardi va buyurtma abadiy
   * PENDING bo'lib qotib qolardi. Endi bekor qilingan buyurtma daftarga
   * MANFIY (kredit) qator sifatida tushadi va lump-sum ustiga qo'shiladi.
   */
  it('⭐ bekor qilingan buyurtmaning extra_cost krediti FIFO`ni qotirmaydi', async () => {
    const { service, store } = makeService([
      {
        order_id: '401',
        courier_id: '7',
        branch_id: '10',
        courier_amount: 30000,
      },
      {
        order_id: '402',
        courier_id: '7',
        branch_id: '10',
        courier_amount: 110000,
      },
      {
        order_id: '403',
        courier_id: '7',
        branch_id: '10',
        courier_amount: 70000,
      },
      // Bekor qilingan buyurtma — faqat kredit oyog'i, eng OXIRGI qator.
      {
        order_id: '404',
        courier_id: '7',
        branch_id: '10',
        courier_amount: -5000,
      },
    ]);

    const res = (await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 205000, // kuryer kassasidagi haqiqiy qoldiq
      requester_id: '1',
    })) as AdvanceResult;

    // Uchala sotuv ham yopiladi; kredit kerak bo'lgan payt (403 dan oldin)
    // tortiladi, shuning uchun ro'yxatda 404 aynan 403 dan oldin turadi.
    expect(res.data.settled_order_ids).toEqual(['401', '402', '404', '403']);
    expect(res.data.allocated).toBe(205000);
    expect(res.data.leftover).toBe(0);
    for (const row of store) {
      expect(row.status).toBe(SettlementStatus.COURIER_SETTLED);
    }
  });

  /**
   * Kredit KECHIKTIRIB tortiladi: qisman to'lovda kerak bo'lmasa PENDING
   * bo'lib qoladi va keyingi to'lovda ishlatiladi. Aks holda u yo'qolib
   * ketadigan `leftover` ichida yonib ketardi va FIFO yana qotib qolardi.
   */
  it('kredit faqat KERAK bo`lganda sarflanadi (qisman to`lovda yonib ketmaydi)', async () => {
    const { service, store } = makeService([
      { order_id: '501', courier_id: '7', courier_amount: 100 },
      { order_id: '502', courier_id: '7', courier_amount: 50 },
      { order_id: '503', courier_id: '7', courier_amount: -20 },
    ]);

    const first = (await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 100,
      requester_id: '1',
    })) as AdvanceResult;
    expect(first.data.settled_order_ids).toEqual(['501']);
    // Kredit hali ishlatilmadi — 502 sig'masa ham u PENDING bo'lib qoladi.
    expect(store[2].status).toBe(SettlementStatus.PENDING);

    const second = (await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 30, // kassada qolgan haqiqiy summa (150 − 20 − 100)
      requester_id: '1',
    })) as AdvanceResult;
    expect(second.data.settled_order_ids).toEqual(['503', '502']);
    expect(second.data.allocated).toBe(30);
    // Filialsiz (HQ) qatorlar — kuryer topshirishi bilan darhol HQ'da.
    expect(store[1].status).toBe(SettlementStatus.BRANCH_SETTLED);
    expect(store[2].status).toBe(SettlementStatus.BRANCH_SETTLED);
  });

  it('kredit yetmasa hech narsa o`zgarmaydi — kredit sarflanmay qoladi', async () => {
    const { service, store } = makeService([
      { order_id: '601', courier_id: '7', courier_amount: 100 },
      { order_id: '602', courier_id: '7', courier_amount: -20 },
    ]);

    const res = (await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 50, // 50 + 20 = 70 < 100
      requester_id: '1',
    })) as AdvanceResult;

    expect(res.data.settled_order_ids).toEqual([]);
    expect(res.data.allocated).toBe(0);
    expect(store[0].status).toBe(SettlementStatus.PENDING);
    expect(store[1].status).toBe(SettlementStatus.PENDING);
  });

  it('legacy cashbox-posting settle* path is retired (throws) so it cannot double-debit', async () => {
    const { service } = makeService([]);
    await expect(
      service.settleCourierToBranch(
        { id: '1', roles: ['manager'] },
        { courier_id: '7', amount: 100 },
      ),
    ).rejects.toThrow();
    await expect(
      service.settleBranchToHq(
        { id: '1', roles: ['manager'] },
        { branch_id: '10', amount: 100 },
      ),
    ).rejects.toThrow();
    await expect(
      service.settleHqToMarket(
        { id: '1', roles: ['manager'] },
        { market_id: '20', amount: 100 },
      ),
    ).rejects.toThrow();
  });

  it('summarizes the whole chain receivable — HQ rows (branch_id NULL) included', async () => {
    const { service, settlementRepo } = makeService([]);
    const makeQb = (rows: any[]) => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    });
    const branchQb = makeQb([
      { branch_id: '10', amount: '150000' },
      { branch_id: '11', amount: '50000' },
      // HQ sotuvi: `resolveSettlementBranchId` null qaytaradi. Ilgari bu qator
      // `branch_id IS NOT NULL` filtri bilan qirqilardi va HQ kuryerlaridagi
      // pul kompaniya holatidan butunlay tushib qolardi (audit M1).
      { branch_id: null, amount: '90000' },
    ]);
    const marketQb = makeQb([
      { market_id: '20', amount: '120000' },
      { market_id: '21', amount: '30000' },
    ]);
    settlementRepo.createQueryBuilder
      .mockReturnValueOnce(branchQb)
      .mockReturnValueOnce(marketQb);

    const response: any = await service.getFinancialBalanceSettlementSummary();

    expect(response.data).toEqual({
      chain_receivable: 290000,
      branch_receivable: 200000,
      hq_receivable: 90000,
      market_payable: 150000,
      branches: [
        { branch_id: '10', amount: 150000 },
        { branch_id: '11', amount: 50000 },
      ],
      markets: [
        { market_id: '20', amount: 120000 },
        { market_id: '21', amount: 30000 },
      ],
    });
    // Filtr olib tashlangani tasdiqlanadi: endi branch_id bo'yicha shart yo'q.
    expect(branchQb.andWhere).not.toHaveBeenCalledWith(
      'settlement.branch_id IS NOT NULL',
    );
    expect(branchQb.andWhere).toHaveBeenCalledWith(
      'settlement.status IN (:...statuses)',
      {
        statuses: [SettlementStatus.PENDING, SettlementStatus.COURIER_SETTLED],
      },
    );
    expect(marketQb.andWhere).toHaveBeenCalledWith(
      'settlement.status IN (:...statuses)',
      {
        statuses: [
          SettlementStatus.PENDING,
          SettlementStatus.COURIER_SETTLED,
          SettlementStatus.BRANCH_SETTLED,
        ],
      },
    );
  });
});
