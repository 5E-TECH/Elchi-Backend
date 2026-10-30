const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
}));

import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { Cashbox_type, Operation_type, Source_type } from '@app/common';
import { CreateProviderReceivables1715800000000 } from '../../../migrations/1715800000000-CreateProviderReceivables';
import { ProviderRemittanceSettledUnapplied1716000000080 } from '../../../migrations/1716000000080-ProviderRemittanceSettledUnapplied';
import { ProviderRemittanceCancel1716000000081 } from '../../../migrations/1716000000081-ProviderRemittanceCancel';
import { ProviderRemittanceAdvance1716000000104 } from '../../../migrations/1716000000104-ProviderRemittanceAdvance';
import { ProviderRemittanceIdempotency1716000000196 } from '../../../migrations/1716000000196-ProviderRemittanceIdempotency';
import { FinanceServiceService } from '../../finance-service/src/finance-service.service';
import { Cashbox } from '../../finance-service/src/entities/cashbox.entity';
import { CashboxCard } from '../../finance-service/src/entities/cashbox-card.entity';
import { CashboxCardMovement } from '../../finance-service/src/entities/cashbox-card-movement.entity';
import { CashboxHistory } from '../../finance-service/src/entities/cashbox-history.entity';
import { Shift } from '../../finance-service/src/entities/shift.entity';
import { IntegrationServiceService } from './integration-service.service';
import {
  ProviderReceivable,
  ReceivableStatus,
} from './entities/provider-receivable.entity';
import { ProviderRemittance } from './entities/provider-remittance.entity';

/**
 * N3yNa6rO TC: bitta remittance'dan keyin MAIN kassa balansi AYNAN bir marta
 * oshadi. Finance bu yerda simulyatsiya EMAS: `finance.cashbox.fill` haqiqiy
 * `fillTheCashbox` ga boradi, balans va tarix haqiqiy Postgres'dan o'qiladi
 * (smena darvozasi yoqilgan).
 *
 * Himoya chegarasi: dedup kaliti — `provider-remittance:<id>`, ya'ni shu
 * remittance'ning kassa yozuvi qayta yetkazilsa pul ikki marta tushmaydi.
 * `POST integrations/:id/remittances` esa `Idempotency-Key` ni o'qimaydi: bu
 * spec HTTP takrorini emas, kassa yozuvi takrorini qotiradi.
 *
 * Env (`INTEGRATION_PG_TEST_URI`) berilmasa skip.
 */
const pgUri = process.env.INTEGRATION_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('N3yNa6rO — remittance → MAIN kassa, haqiqiy Postgres', () => {
  const dbName = `spec_n3y_remit_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const ORIGINAL_ENV = process.env.FINANCE_REQUIRE_OPEN_SHIFT;
  const START_BALANCE = 500_000;
  let admin: DataSource;
  let db: DataSource;
  let financeDb: DataSource;
  let finance: FinanceServiceService;
  let svc: any;

  const mainCashbox = () =>
    financeDb
      .getRepository(Cashbox)
      .findOneByOrFail({ user_id: '0', cashbox_type: Cashbox_type.MAIN });

  const remittanceRows = (id: unknown) =>
    financeDb.getRepository(CashboxHistory).findBy({
      dedup_epoch: `provider-remittance:${String(id)}`,
    });

  const fillCalls = () =>
    rmqSendMock.mock.calls.filter(
      (c: any[]) => c[1]?.cmd === 'finance.cashbox.fill',
    );

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
    for (const migration of [
      new CreateProviderReceivables1715800000000(),
      new ProviderRemittanceSettledUnapplied1716000000080(),
      new ProviderRemittanceCancel1716000000081(),
      new ProviderRemittanceAdvance1716000000104(),
      new ProviderRemittanceIdempotency1716000000196(),
    ]) {
      await migration.up(runner);
    }
    await runner.release();

    await db.query('CREATE SCHEMA IF NOT EXISTS "finance_schema"');
    financeDb = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [
        Cashbox,
        CashboxHistory,
        Shift,
        CashboxCard,
        CashboxCardMovement,
      ],
      synchronize: true,
      extra: { max: 10 },
    });
    await financeDb.initialize();
    finance = new FinanceServiceService(
      financeDb.getRepository(Cashbox),
      financeDb.getRepository(CashboxHistory),
      financeDb.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      financeDb,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { send: jest.fn(() => of({ statusCode: 200 })) } as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    );

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
    if (ORIGINAL_ENV === undefined) {
      delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    } else {
      process.env.FINANCE_REQUIRE_OPEN_SHIFT = ORIGINAL_ENV;
    }
    if (financeDb?.isInitialized) await financeDb.destroy();
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    rmqSendMock.mockReset();
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }, payload: any) =>
        pattern.cmd === 'finance.cashbox.fill'
          ? finance.fillTheCashbox(payload)
          : Promise.resolve({ statusCode: 200, data: {} }),
    );
    await db.query(
      `TRUNCATE "integration_schema"."provider_receivables",
                "integration_schema"."provider_remittances" RESTART IDENTITY`,
    );
    await financeDb.query(
      `TRUNCATE TABLE "finance_schema".cashbox_history,
        "finance_schema".shifts, "finance_schema".cashboxes
        RESTART IDENTITY CASCADE`,
    );
    const cashboxes = financeDb.getRepository(Cashbox);
    await cashboxes.save(
      cashboxes.create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        balance: START_BALANCE,
        balance_cash: START_BALANCE,
        balance_card: 0,
      }),
    );
    const receivables = db.getRepository(ProviderReceivable);
    await receivables.save(
      receivables.create({
        integration_id: '2',
        order_id: '1001',
        amount: '340000.00',
        status: ReceivableStatus.PENDING,
      }),
    );
  });

  it('⭐ TC: bitta remittance — MAIN aynan summaga bir marta oshadi, tarixda bitta qator', async () => {
    await finance.openShift({ opened_by: '1' });

    const res = await svc.createRemittance({
      integration_id: '2',
      amount: 340_000,
      order_ids: ['1001'],
      created_by: '1',
    });

    expect(res.data).toMatchObject({
      settled_count: 1,
      unapplied_amount: 0,
      cashbox_posted: true,
    });
    expect(fillCalls()).toHaveLength(1);
    const main = await mainCashbox();
    expect(Number(main.balance)).toBe(START_BALANCE + 340_000);
    expect(Number(main.balance_cash)).toBe(START_BALANCE + 340_000);

    const rows = await remittanceRows(res.data.remittance_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cashbox_id: String(main.id),
      operation_type: Operation_type.INCOME,
      source_type: Source_type.MANUAL_INCOME,
    });
    expect(Number(rows[0].amount)).toBe(340_000);
    expect(Number(rows[0].balance_after)).toBe(START_BALANCE + 340_000);
    expect(await financeDb.getRepository(CashboxHistory).count()).toBe(1);
  });

  it('⭐ TC: kassa yozuvi qayta yetkazilsa (ayni dedup_epoch) — balans yana oshmaydi', async () => {
    await finance.openShift({ opened_by: '1' });
    const res = await svc.createRemittance({
      integration_id: '2',
      amount: 340_000,
      order_ids: ['1001'],
      created_by: '1',
    });
    const payload = fillCalls()[0][2];

    const replays: any[] = await Promise.all([
      finance.fillTheCashbox(payload),
      finance.fillTheCashbox(payload),
    ]);

    expect(replays.map((r) => r.data.idempotent)).toEqual([true, true]);
    expect(Number((await mainCashbox()).balance)).toBe(START_BALANCE + 340_000);
    expect(await remittanceRows(res.data.remittance_id)).toHaveLength(1);
  });

  it('parallel birinchi yetkazish ham — kassa qulfi ostida token bir marta yoziladi', async () => {
    await finance.openShift({ opened_by: '1' });
    const payload = {
      user_id: '1',
      cashbox_type: Cashbox_type.MAIN,
      amount: 70_000,
      created_by: '1',
      dedup_epoch: 'provider-remittance:900',
    };

    await Promise.all([
      finance.fillTheCashbox(payload),
      finance.fillTheCashbox(payload),
    ]);

    expect(Number((await mainCashbox()).balance)).toBe(START_BALANCE + 70_000);
    expect(await remittanceRows('900')).toHaveLength(1);
  });

  it('ikki alohida remittance — har biri o`z kirimi, dedup haqiqiy to`lovni yutmaydi', async () => {
    await finance.openShift({ opened_by: '1' });

    const first = await svc.createRemittance({
      integration_id: '2',
      amount: 340_000,
      created_by: '1',
    });
    const second = await svc.createRemittance({
      integration_id: '2',
      amount: 60_000,
      created_by: '1',
    });

    expect(Number((await mainCashbox()).balance)).toBe(START_BALANCE + 400_000);
    expect(await remittanceRows(first.data.remittance_id)).toHaveLength(1);
    expect(await remittanceRows(second.data.remittance_id)).toHaveLength(1);
  });

  it('smena yopiq — cashbox_posted=false, MAIN o`zgarmaydi, tarix bo`sh, remittance saqlanadi', async () => {
    const res = await svc.createRemittance({
      integration_id: '2',
      amount: 340_000,
      order_ids: ['1001'],
      created_by: '1',
    });

    expect(res.data.cashbox_posted).toBe(false);
    expect(Number((await mainCashbox()).balance)).toBe(START_BALANCE);
    expect(await financeDb.getRepository(CashboxHistory).count()).toBe(0);
    const row = await db
      .getRepository(ProviderRemittance)
      .findOneByOrFail({ id: String(res.data.remittance_id) });
    expect(row.cashbox_posted).toBe(false);
  });
});
