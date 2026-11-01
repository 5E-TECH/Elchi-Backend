import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IdempotencyKey, SettlementStatus } from '@app/common';
import { OrderSettlementService } from './order-settlement.service';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';

/**
 * Moliyaviy balans: kargo qo'lidagi naqd zanjirda sanalmaydi, haqiqiy Postgres
 * (ORDER_SETTLEMENT_PG_TEST_URI bo'lmasa skip; o'z per-run sxemasida).
 *
 * Invariant: `chain_receivable` — kuryer va filial qo'lidagi pul. Kuryersiz va
 * filialsiz PENDING qator `provider_held` ga ajraladi: finance kargo pulini shu
 * yig'indi va `provider_receivables` dan bir marta oladi.
 */
const pgUri = process.env.ORDER_SETTLEMENT_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('Moliyaviy balans: kargo naqdi — haqiqiy Postgres', () => {
  const schema = `spec_prov_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: OrderSettlementService;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      entities: [OrderSettlement, OrderSettlementCarry, IdempotencyKey],
      synchronize: true,
    });
    await db.initialize();
    service = new OrderSettlementService(
      db,
      db.getRepository(OrderSettlement),
      { send: jest.fn() } as never,
      { getHqBranchId: () => Promise.resolve('1') } as never,
    );
  }, 30_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE "${schema}".order_settlement, "${schema}".order_settlement_carry RESTART IDENTITY`,
    );
  });

  let seq = 0;
  const row = async (input: {
    courier_id?: string | null;
    branch_id?: string | null;
    branch_amount: number;
    market_amount: number;
    status: SettlementStatus;
    isDeleted?: boolean;
  }) => {
    seq += 1;
    await db.getRepository(OrderSettlement).save(
      db.getRepository(OrderSettlement).create({
        order_id: String(1000 + seq),
        courier_id: input.courier_id ?? null,
        branch_id: input.branch_id ?? null,
        market_id: '20',
        courier_amount: input.branch_amount,
        branch_amount: input.branch_amount,
        market_amount: input.market_amount,
        status: input.status,
        isDeleted: input.isDeleted ?? false,
      }),
    );
  };

  const summary = async () =>
    (
      (await service.getFinancialBalanceSettlementSummary()) as {
        data: {
          chain_receivable: number;
          branch_receivable: number;
          hq_receivable: number;
          market_payable: number;
          provider_held?: number;
        };
      }
    ).data;

  it('kargoda turgan PENDING qator zanjirga kirmaydi', async () => {
    await row({
      branch_amount: 2_000_000,
      market_amount: 1_850_000,
      status: SettlementStatus.PENDING,
    });
    await row({
      courier_id: '15',
      branch_id: '3',
      branch_amount: 100_000,
      market_amount: 70_000,
      status: SettlementStatus.PENDING,
    });
    await row({
      courier_id: '392',
      branch_amount: 50_000,
      market_amount: 30_000,
      status: SettlementStatus.PENDING,
    });
    await row({
      branch_id: '7',
      branch_amount: 145_000,
      market_amount: 120_000,
      status: SettlementStatus.COURIER_SETTLED,
    });

    const data = await summary();

    expect(data.chain_receivable).toBe(295_000);
    expect(data.branch_receivable).toBe(245_000);
    expect(data.hq_receivable).toBe(50_000);
    expect(data.provider_held).toBe(2_000_000);
    // Marketga qarz kargo qatorini ham o'z ichiga oladi: market pulini oladi.
    expect(data.market_payable).toBe(2_070_000);
  });

  it("HQ'ga yetgan kargo va HQ sotuvi qatori zanjirga kirmaydi", async () => {
    await row({
      branch_amount: 340_000,
      market_amount: 310_000,
      status: SettlementStatus.BRANCH_SETTLED,
    });
    await row({
      courier_id: '392',
      branch_amount: 80_000,
      market_amount: 60_000,
      status: SettlementStatus.BRANCH_SETTLED,
    });

    const data = await summary();
    expect(data.chain_receivable).toBe(0);
    expect(data.provider_held).toBeUndefined();
  });

  it("o'chirilgan qator sanalmaydi", async () => {
    await row({
      courier_id: '15',
      branch_id: '3',
      branch_amount: 90_000,
      market_amount: 60_000,
      status: SettlementStatus.PENDING,
      isDeleted: true,
    });
    await row({
      branch_amount: 70_000,
      market_amount: 40_000,
      status: SettlementStatus.PENDING,
      isDeleted: true,
    });

    const data = await summary();
    expect(data.chain_receivable).toBe(0);
    expect(data.provider_held).toBeUndefined();
  });
});
