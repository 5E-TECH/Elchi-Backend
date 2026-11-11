import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IdempotencyKey, SettlementStatus } from '@app/common';
import { OrderSettlementService } from './order-settlement.service';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';

/**
 * AUDIT M4 (2026-11-11) — menejer orqali «Marketga o'tkazma» va filial
 * kassasidan marketga to'lov: finance pul tranzaksiyasida navbatga qo'yadigan
 * siljishlar daftarni (order_settlement) qanday o'zgartiradi. Haqiqiy
 * Postgres (`ORDER_SETTLEMENT_PG_TEST_URI`).
 *
 * Finance tomoni (`applyCourierPaymentInTx` / `applyMarketPaymentInTx`):
 *   • click_to_market, filial kassasi orqali (+X / −X, sof 0):
 *     courier_to_branch X (`tok`) → branch_to_hq X (`tok:b`) →
 *     hq_to_market X (`tok:m`);
 *   • filial kassasidan marketga (filial −X): branch_to_hq X (`tok:b`) →
 *     hq_to_market X (`tok`).
 *
 * Asosiy o'lchov — menejer ekranidagi `order.settlement.branch_summary`:
 *   `branch_payable` («HQ ga berilishi kerak») va `courier_receivable`
 *   («kuryerlardan olinishi kerak»). Hamkor bo'lmagan filialda
 *   (`courier_amount = branch_amount`) har qadamda:
 *     courier_receivable = kuryerlar qo'lidagi qarz,
 *     branch_payable     = filial kassasidagi naqd + courier_receivable.
 * Ya'ni filial kassasidan o'tib darhol marketga ketgan pul filial qarzini
 * na oshiradi, na kamaytiradi; filial kassasidan to'langan pul esa
 * kassadagi pul bilan birga kamayadi.
 */
const pgUri = process.env.ORDER_SETTLEMENT_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const BRANCH = '15';
const COURIER = '209';
const MARKET = '201';

describePg('M4 — menejer orqali marketga to`lov — haqiqiy Postgres', () => {
  const schema = `spec_m4_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
      // HQ filial id si — 1 (bu testdagi filial 15 — oddiy filial).
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

  /**
   * Ikki buyurtma, bitta filial kuryeri, bitta market (hamkor bo'lmagan
   * filial — `courier_amount = branch_amount`):
   *   A: kuryer/filial 300 000, marketga 270 000;
   *   B: kuryer/filial 200 000, marketga 180 000.
   * Kuryer qarzi 500 000, marketga qarz 450 000.
   */
  let rows: { a: OrderSettlement; b: OrderSettlement };
  let seq = 0;
  beforeEach(async () => {
    await db.query(
      `TRUNCATE "${schema}".order_settlement, "${schema}".order_settlement_carry,
        "${schema}".idempotency_keys RESTART IDENTITY`,
    );
    const make = async (courier: number, market: number) => {
      seq += 1;
      const saved = await db.getRepository(OrderSettlement).save(
        db.getRepository(OrderSettlement).create({
          order_id: String(5000 + seq),
          courier_id: COURIER,
          branch_id: BRANCH,
          market_id: MARKET,
          courier_amount: courier,
          branch_amount: courier,
          market_amount: market,
          status: SettlementStatus.PENDING,
        }),
      );
      // createdAt tartibi aniq bo'lsin (FIFO: A — eng eski).
      await db.query(
        `UPDATE "${schema}".order_settlement SET "createdAt" = now() + ($1 || ' seconds')::interval WHERE id = $2`,
        [String(seq), saved.id],
      );
      return saved;
    };
    rows = {
      a: await make(300_000, 270_000),
      b: await make(200_000, 180_000),
    };
  });

  const advance = (
    level: 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market',
    match: string,
    amount: number,
    token: string,
  ) =>
    service.advanceSettlement({
      level,
      match_value: match,
      amount,
      request_id: token,
      requester_id: '15001',
    });

  /** Finance «Marketga o'tkazma» (menejer, filial kassasi) navbati. */
  const clickToMarketViaBranch = async (amount: number, token: string) => {
    await advance('courier_to_branch', COURIER, amount, token);
    await advance('branch_to_hq', BRANCH, amount, `${token}:b`);
    await advance('hq_to_market', MARKET, amount, `${token}:m`);
  };

  /** Finance «Marketga to'lov» (menejer, filial kassasidan) navbati. */
  const marketPaymentFromBranch = async (amount: number, token: string) => {
    await advance('branch_to_hq', BRANCH, amount, `${token}:b`);
    await advance('hq_to_market', MARKET, amount, token);
  };

  const branchSummary = async () =>
    (
      (await service.getBranchSettlementSummary({
        branch_id: BRANCH,
        courier_ids: [COURIER],
      })) as {
        data: { branch_payable: number; courier_receivable: number };
      }
    ).data;

  const companySummary = async () =>
    (
      (await service.getFinancialBalanceSettlementSummary()) as {
        data: { chain_receivable: number; market_payable: number };
      }
    ).data;

  const statusOf = async (row: OrderSettlement) =>
    (await db.getRepository(OrderSettlement).findOneByOrFail({ id: row.id }))
      .status;

  /**
   * Kassalar holati (finance'dagi haqiqiy pul) va daftar bir-biriga mos.
   * `branchCash` — filial kassasidagi naqd, `courierDebt` — kuryer qo'lidagi.
   */
  const expectInvariant = async (branchCash: number, courierDebt: number) => {
    const summary = await branchSummary();
    expect(summary.courier_receivable).toBe(courierDebt);
    expect(summary.branch_payable).toBe(branchCash + courierDebt);
  };

  it('daftar boshlang`ich holati — kuryer 500 000, filial qarzi 500 000, marketga 450 000', async () => {
    await expectInvariant(0, 500_000);
    expect(await companySummary()).toMatchObject({
      chain_receivable: 500_000,
      market_payable: 450_000,
    });
  });

  describe('«Marketga o`tkazma» (click_to_market) menejer orqali', () => {
    it('⭐ filial qarzi soxta oshmaydi: olinishi −X, berilishi −X, kompaniya holati o`zgarmaydi', async () => {
      await clickToMarketViaBranch(450_000, 'gw:ctm-1');

      // Filial kassasi: +450 000 −450 000 = 0. Kuryerda 50 000 qoldi.
      await expectInvariant(0, 50_000);
      const company = await companySummary();
      // Zanjir −450 000, marketga qarz −450 000 → holat (main + zanjir −
      // market) o'zgarmaydi (MAIN tegilmadi).
      expect(company.chain_receivable).toBe(50_000);
      expect(company.market_payable).toBe(0);
      // A butunlay yopildi; B — kuryerda (qisman qoldiq bilan).
      expect(await statusOf(rows.a)).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await statusOf(rows.b)).toBe(SettlementStatus.PENDING);

      // Kuryer qolgan 50 000 ni naqd filialga topshiradi.
      await advance('courier_to_branch', COURIER, 50_000, 'gw:cash-1');
      await expectInvariant(50_000, 0);
      expect(await statusOf(rows.b)).toBe(SettlementStatus.COURIER_SETTLED);

      // HQ filialdan 50 000 ni oladi — hammasi yopiladi, qoldiq yo'q.
      await advance('branch_to_hq', BRANCH, 50_000, 'gw:b2h-1');
      await expectInvariant(0, 0);
      expect(await statusOf(rows.b)).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await companySummary()).toMatchObject({
        chain_receivable: 0,
        market_payable: 0,
      });
      const carries = await db.getRepository(OrderSettlementCarry).find();
      expect(carries.every((row) => Number(row.amount) === 0)).toBe(true);
    });

    it('eski xato (faqat courier_to_branch) — filialda yo`q 450 000 «HQ ga berilishi kerak» bo`lib qolardi', async () => {
      await advance('courier_to_branch', COURIER, 450_000, 'gw:old-1');
      const summary = await branchSummary();
      expect(summary.courier_receivable).toBe(50_000);
      // Filial kassasi 0 + kuryer 50 000 bo'lishi kerak edi — 450 000 soxta.
      expect(summary.branch_payable).toBe(500_000);
      expect(summary.branch_payable - (0 + 50_000)).toBe(450_000);
    });

    it('outbox teskari tartibda yetkazsa ham (m → b → c) natija bir xil', async () => {
      await advance('hq_to_market', MARKET, 450_000, 'gw:ctm-2:m');
      await advance('branch_to_hq', BRANCH, 450_000, 'gw:ctm-2:b');
      // Hali kuryer bo'g'ini yo'q — qoldiqlar kutib turadi.
      await advance('courier_to_branch', COURIER, 450_000, 'gw:ctm-2');

      await expectInvariant(0, 50_000);
      expect(await companySummary()).toMatchObject({
        chain_receivable: 50_000,
        market_payable: 0,
      });
      expect(await statusOf(rows.a)).toBe(SettlementStatus.MARKET_SETTLED);
    });

    it('takroriy yetkazish (RMQ / outbox) — daftar ikki marta siljimaydi', async () => {
      await clickToMarketViaBranch(450_000, 'gw:ctm-3');
      const before = await branchSummary();
      await clickToMarketViaBranch(450_000, 'gw:ctm-3');
      expect(await branchSummary()).toEqual(before);
      await expectInvariant(0, 50_000);
    });

    it('qisman (bitta buyurtmaga ham sig`maydi) — qoldiq bilan, invariant saqlanadi', async () => {
      await clickToMarketViaBranch(100_000, 'gw:ctm-4');
      await expectInvariant(0, 400_000);
      expect(await companySummary()).toMatchObject({
        chain_receivable: 400_000,
        market_payable: 350_000,
      });
      // Hech bir butun buyurtma yopilmadi — summa qoldiqlarda.
      expect(await statusOf(rows.a)).toBe(SettlementStatus.PENDING);
    });
  });

  describe('«Marketga to`lov» filial kassasidan (naqd / karta)', () => {
    it('⭐ filial kassasidagi pul va «HQ ga berilishi kerak» birga kamayadi', async () => {
      // Kuryer hammasini naqd filialga topshirgan: filial kassasi 500 000.
      await advance('courier_to_branch', COURIER, 500_000, 'gw:cash-2');
      await expectInvariant(500_000, 0);

      // Menejer marketga 270 000 to'laydi (filial kassasi −270 000).
      await marketPaymentFromBranch(270_000, 'gw:mp-1');
      await expectInvariant(230_000, 0);
      expect(await companySummary()).toMatchObject({
        chain_receivable: 230_000,
        market_payable: 180_000,
      });

      // HQ qolgan 230 000 ni oladi — A va B yopiladi, market qoldig'i A ni
      // MARKET_SETTLED qiladi; B uchun HQ marketga hali 180 000 qarz.
      await advance('branch_to_hq', BRANCH, 230_000, 'gw:b2h-2');
      await expectInvariant(0, 0);
      expect(await statusOf(rows.a)).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await statusOf(rows.b)).toBe(SettlementStatus.BRANCH_SETTLED);
      expect(await companySummary()).toMatchObject({
        chain_receivable: 0,
        market_payable: 180_000,
      });
    });

    it('butun summa — barcha buyurtmalar yopiladi', async () => {
      await advance('courier_to_branch', COURIER, 500_000, 'gw:cash-3');
      await marketPaymentFromBranch(450_000, 'gw:mp-2');
      await expectInvariant(50_000, 0);
      expect(await companySummary()).toMatchObject({
        chain_receivable: 50_000,
        market_payable: 0,
      });
      expect(await statusOf(rows.a)).toBe(SettlementStatus.MARKET_SETTLED);
      // B: filial qoldig'i (450 000 − 300 000 = 150 000) B ga (200 000)
      // sig'madi — HQ qolgan 50 000 ni olganda yopiladi.
      expect(await statusOf(rows.b)).toBe(SettlementStatus.COURIER_SETTLED);
      await advance('branch_to_hq', BRANCH, 50_000, 'gw:b2h-3');
      expect(await statusOf(rows.b)).toBe(SettlementStatus.MARKET_SETTLED);
      await expectInvariant(0, 0);
    });

    it('takroriy yetkazish — o`zgarish yo`q', async () => {
      await advance('courier_to_branch', COURIER, 500_000, 'gw:cash-4');
      await marketPaymentFromBranch(270_000, 'gw:mp-3');
      await marketPaymentFromBranch(270_000, 'gw:mp-3');
      await expectInvariant(230_000, 0);
    });
  });
});
