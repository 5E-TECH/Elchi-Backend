const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
}));

import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CreateProviderReceivables1715800000000 } from '../../../migrations/1715800000000-CreateProviderReceivables';
import { ProviderRemittanceSettledUnapplied1716000000080 } from '../../../migrations/1716000000080-ProviderRemittanceSettledUnapplied';
import { ProviderRemittanceCancel1716000000081 } from '../../../migrations/1716000000081-ProviderRemittanceCancel';
import { IntegrationServiceService } from './integration-service.service';
import {
  ProviderReceivable,
  ReceivableStatus,
} from './entities/provider-receivable.entity';
import {
  ProviderRemittance,
  RemittanceStatus,
} from './entities/provider-remittance.entity';

/**
 * Haqiqiy Postgres (INTEGRATION_PG_TEST_URI bo'lmasa skip). Alohida vaqtinchalik
 * BAZA yaratiladi (migratsiyalar `integration_schema` ni qattiq yozadi).
 *
 *  • migratsiya 080/081: ustunlar bor, entity ular bilan mos (synchronize
 *    YO'Q — faqat migratsiya sxemasi), down() ularni olib tashlaydi;
 *  • utIffRFx: qoldiq yozuvda saqlanadi;
 *  • DxdZFdIk: bekor qilish — qarz PENDING, outstanding ortadi, parallel
 *    ikki bosishda yozuv bir marta bekor bo'ladi, kassa tokeni bitta.
 */
const pgUri = process.env.INTEGRATION_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('B4 remittance (utIffRFx, DxdZFdIk) — haqiqiy Postgres', () => {
  const dbName = `spec_b4_remit_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let svc: any;
  const migrations = [
    new CreateProviderReceivables1715800000000(),
    new ProviderRemittanceSettledUnapplied1716000000080(),
    new ProviderRemittanceCancel1716000000081(),
  ];
  // Finance idempotentligi simulyatsiyasi: bir token — bir harakat.
  const appliedTokens = new Map<string, number>();

  const columnsOf = async (table: string): Promise<string[]> => {
    const rows: Array<{ column_name: string }> = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'integration_schema' AND table_name = $1`,
      [table],
    );
    return rows.map((r) => r.column_name);
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'integration_schema',
      entities: [ProviderReceivable, ProviderRemittance],
      synchronize: false,
    });
    await db.initialize();
    await db.query('CREATE SCHEMA IF NOT EXISTS "integration_schema"');
    const runner = db.createQueryRunner();
    for (const migration of migrations) {
      await migration.up(runner);
    }
    await runner.release();

    svc = Object.create(IntegrationServiceService.prototype);
    svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    svc.integrationRepo = {
      findOne: jest.fn(() => Promise.resolve({ id: '2', slug: 'kargo' })),
    };
    svc.receivableRepo = db.getRepository(ProviderReceivable);
    svc.remittanceRepo = db.getRepository(ProviderRemittance);
    svc.financeClient = { name: 'FINANCE' };
    svc.orderClient = { name: 'ORDER' };
    svc.activityLog = { log: jest.fn(() => Promise.resolve()) };
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    appliedTokens.clear();
    rmqSendMock.mockReset();
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }, payload: any) => {
        if (pattern.cmd.startsWith('finance.cashbox.')) {
          const token = String(payload?.dedup_epoch ?? '');
          appliedTokens.set(token, (appliedTokens.get(token) ?? 0) + 1);
        }
        return Promise.resolve({ statusCode: 200, data: {} });
      },
    );
    await db.query(
      `TRUNCATE "integration_schema"."provider_receivables",
                "integration_schema"."provider_remittances" RESTART IDENTITY`,
    );
    const repo = db.getRepository(ProviderReceivable);
    for (const [order, amount] of [
      ['1001', '1200000.00'],
      ['1002', '2000000.00'],
    ] as const) {
      await repo.save(
        repo.create({
          integration_id: '2',
          order_id: order,
          amount,
          status: ReceivableStatus.PENDING,
        }),
      );
    }
  });

  it('migratsiya 080/081 ustunlari bor (mavjud qatorlar uchun status=active sukuti)', async () => {
    const cols = await columnsOf('provider_remittances');
    expect(cols).toEqual(
      expect.arrayContaining([
        'settled_amount',
        'unapplied_amount',
        'status',
        'cancelled_at',
        'cancelled_by',
        'cancel_reason',
        'cashbox_posted',
      ]),
    );
    // Eski shakldagi INSERT (yangi ustunlarsiz) — sukutlar.
    await db.query(
      `INSERT INTO "integration_schema"."provider_remittances"
         (integration_id, amount, settled_count) VALUES (9, 10, 0)`,
    );
    const [legacy] = await db.query(
      `SELECT status, settled_amount, unapplied_amount, cashbox_posted
         FROM "integration_schema"."provider_remittances" WHERE integration_id = 9`,
    );
    expect(legacy).toEqual({
      status: 'active',
      settled_amount: null,
      unapplied_amount: null,
      cashbox_posted: null,
    });
  });

  it('utIffRFx: outstanding + 1 000 000 → qoldiq yozuvda saqlanadi, cashbox_posted=true', async () => {
    const res = await svc.createRemittance({
      integration_id: '2',
      amount: 4_200_000,
      reference: 'PAY-001',
      created_by: '1',
    });

    expect(res.data.unapplied_amount).toBe(1_000_000);
    const row = await db
      .getRepository(ProviderRemittance)
      .findOneByOrFail({ id: String(res.data.remittance_id) });
    expect(row).toMatchObject({
      settled_count: 2,
      settled_amount: '3200000.00',
      unapplied_amount: '1000000.00',
      status: RemittanceStatus.ACTIVE,
      cashbox_posted: true,
      reference: 'PAY-001',
    });

    const list = await svc.listRemittances({ integration_id: '2' });
    expect(list.data.items).toHaveLength(1);
    expect(list.data.items[0]).toMatchObject({
      reference: 'PAY-001',
      unapplied_amount: 1_000_000,
    });
  });

  it('⭐ DxdZFdIk: bekor qilish — qarz qatorlari PENDING, outstanding_amount ortadi, kassa teskari chiqimi bir marta', async () => {
    const created = await svc.createRemittance({
      integration_id: '2',
      amount: 3_200_000,
      created_by: '1',
    });
    const before = await svc.getProviderBalance('2');
    expect(before.data.outstanding_amount).toBe(0);

    const res = await svc.cancelRemittance({
      integration_id: '2',
      remittance_id: String(created.data.remittance_id),
      reason: 'xato',
      cancelled_by: '9',
    });

    expect(res.data).toMatchObject({
      status: RemittanceStatus.CANCELLED,
      reopened_count: 2,
      cashbox_reversed: true,
    });
    const after = await svc.getProviderBalance('2');
    expect(after.data.outstanding_amount).toBe(3_200_000);
    const rows = await db.getRepository(ProviderReceivable).find();
    expect(
      rows.every(
        (r) =>
          r.status === ReceivableStatus.PENDING && r.remittance_id === null,
      ),
    ).toBe(true);
    expect(
      appliedTokens.get(
        `provider-remittance-cancel:${String(created.data.remittance_id)}`,
      ),
    ).toBe(1);

    // Takroriy bekor qilish — idempotent, kassaga qayta tegilmaydi.
    const again = await svc.cancelRemittance({
      integration_id: '2',
      remittance_id: String(created.data.remittance_id),
    });
    expect(again.data.idempotent).toBe(true);
    expect(
      appliedTokens.get(
        `provider-remittance-cancel:${String(created.data.remittance_id)}`,
      ),
    ).toBe(1);
  });

  it('parallel ikki bekor qilish — yozuv bir marta bekor bo`ladi, kassa tokeni bitta (finance dedup qiladi)', async () => {
    const created = await svc.createRemittance({
      integration_id: '2',
      amount: 3_200_000,
    });
    const id = String(created.data.remittance_id);

    const results = await Promise.all([
      svc.cancelRemittance({ integration_id: '2', remittance_id: id }),
      svc.cancelRemittance({ integration_id: '2', remittance_id: id }),
    ]);

    const fresh = results.filter((r: any) => !r.data.idempotent);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].data.reopened_count).toBe(2);
    const spendTokens = rmqSendMock.mock.calls
      .filter((c: any[]) => c[1]?.cmd === 'finance.cashbox.spend')
      .map((c: any[]) => c[2].dedup_epoch);
    expect(new Set(spendTokens)).toEqual(
      new Set([`provider-remittance-cancel:${id}`]),
    );
    const pending = await db
      .getRepository(ProviderReceivable)
      .countBy({ status: ReceivableStatus.PENDING });
    expect(pending).toBe(2);
  });

  it('migratsiya down() — 081 va 080 ustunlarni olib tashlaydi, keyin qayta up()', async () => {
    const runner = db.createQueryRunner();
    try {
      await migrations[2].down(runner);
      await migrations[1].down(runner);
      const cols = await columnsOf('provider_remittances');
      for (const col of [
        'settled_amount',
        'unapplied_amount',
        'status',
        'cancelled_at',
        'cancelled_by',
        'cancel_reason',
        'cashbox_posted',
      ]) {
        expect(cols).not.toContain(col);
      }
    } finally {
      await migrations[1].up(runner);
      await migrations[2].up(runner);
      await runner.release();
    }
  });
});
