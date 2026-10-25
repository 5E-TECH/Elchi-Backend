import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { Cashbox_type, OutboxEvent, OutboxService } from '@app/common';
import { FinanceServiceService } from '../finance-service.service';
import { CashboxCardService } from '../cashbox-card/cashbox-card.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { Shift, ShiftStatus } from '../entities/shift.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import {
  CardMovementType,
  CashboxCardMovement,
} from '../entities/cashbox-card-movement.entity';
import { FinanceRealtimeService } from './finance-realtime.service';

/**
 * rWdLuoP3 (2026-10-25) — HAQIQIY Postgres: smena yopilishi va kassa kartasi
 * o'zgarishi `outbox_events` ga (`GATEWAY` / `realtime.notify`) AYNI
 * tranzaksiyada yoziladi: yopish commit bo'lsa — bitta qator, rollback bo'lsa
 * — qator ham yo'q; idempotent takror — yangi hodisa yo'q.
 * Env (`FINANCE_PG_TEST_URI`) berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

type OutboxRow = {
  target: string;
  pattern: string;
  status: string;
  payload: {
    event: string;
    payload: Record<string, unknown>;
    targets: Array<Record<string, string>>;
  };
};

describePg('rWdLuoP3 — realtime hodisasi outbox`da, haqiqiy Postgres', () => {
  const schema = `spec_rtshift_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let finance: FinanceServiceService;
  let cards: CashboxCardService;
  let realtime: FinanceRealtimeService;
  const ORIGINAL_ENV = process.env.FINANCE_REQUIRE_OPEN_SHIFT;

  const build = (enabled: boolean) => {
    const outbox = new OutboxService(db.getRepository(OutboxEvent));
    realtime = new FinanceRealtimeService(outbox, {
      get: () => (enabled ? 'gateway_queue' : ''),
    } as never);
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      db,
      activityLog as never,
      { send: jest.fn(() => of({ statusCode: 200 })) } as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
      undefined,
      undefined,
      undefined,
      realtime,
    );
    cards = new CashboxCardService(db, activityLog as never, realtime);
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      entities: [
        Cashbox,
        CashboxHistory,
        Shift,
        CashboxCard,
        CashboxCardMovement,
        OutboxEvent,
      ],
      synchronize: true,
      extra: { max: 10 },
    });
    await db.initialize();
  }, 30_000);

  afterAll(async () => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    } else {
      process.env.FINANCE_REQUIRE_OPEN_SHIFT = ORIGINAL_ENV;
    }
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_card_movements,
        "${schema}".cashbox_cards, "${schema}".cashbox_history,
        "${schema}".shifts, "${schema}".cashboxes, "${schema}".outbox_events
        RESTART IDENTITY CASCADE`,
    );
    const repo = db.getRepository(Cashbox);
    await repo.save([
      repo.create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        balance: 600_000,
        balance_cash: 500_000,
        balance_card: 100_000,
      }),
      repo.create({
        user_id: '15',
        cashbox_type: Cashbox_type.BRANCH,
        balance: 100_000,
        balance_cash: 100_000,
        balance_card: 0,
      }),
    ]);
    build(true);
  });

  const rows = (): Promise<OutboxRow[]> =>
    db.getRepository(OutboxEvent).find({ order: { id: 'ASC' } }) as never;

  const openShift = async (openedBy: string, cashboxUserId?: string) => {
    const res: any = await finance.openShift({
      opened_by: openedBy,
      ...(cashboxUserId ? { cashbox_user_id: cashboxUserId } : {}),
    } as never);
    return String(res.data.id);
  };

  it('MAIN smena yopildi → bitta pending qator: GATEWAY / realtime.notify, `finance.shift.closed`, `closed_at` = bazadagi vaqt; ochish hodisa yozmaydi', async () => {
    const shiftId = await openShift('3');
    expect(await rows()).toEqual([]);

    await finance.closeShift({ shift_id: shiftId, closed_by: '2' } as never);

    const all = await rows();
    expect(all).toHaveLength(1);
    const [row] = all;
    expect([row.target, row.pattern, row.status]).toEqual([
      'GATEWAY',
      'realtime.notify',
      'pending',
    ]);
    const shift = await db
      .getRepository(Shift)
      .findOneByOrFail({ id: shiftId });
    expect(row.payload.event).toBe('finance.shift.closed');
    expect(row.payload.payload).toMatchObject({
      shift_id: shiftId,
      cashbox_type: 'main',
      branch_id: null,
      close_reason: 'manual',
      closed_by: '2',
      opened_by: '3',
      closed_at: (shift.closed_at as Date).toISOString(),
    });
    expect(row.payload.targets).toEqual([
      { role: 'superadmin' },
      { role: 'admin' },
      { role: 'registrator' },
      { user_id: '3' },
      { user_id: '2' },
    ]);

    // Ikkinchi marta yopish — 400, yangi hodisa yo'q.
    await expect(
      finance.closeShift({ shift_id: shiftId, closed_by: '2' } as never),
    ).rejects.toBeDefined();
    expect(await rows()).toHaveLength(1);
  });

  it('⭐ filial smenasi (menejer doirasi 15) → nishon faqat `manager` @ 15-filial + kassir', async () => {
    const shiftId = await openShift('25', '15');
    await finance.closeShift({
      closed_by: '25',
      cashbox_user_id: '15',
    } as never);

    const [row] = await rows();
    expect(row.payload.payload).toMatchObject({
      shift_id: shiftId,
      cashbox_user_id: '15',
      cashbox_type: 'branch',
      branch_id: '15',
    });
    expect(row.payload.targets).toEqual([
      { role: 'manager', branch_id: '15' },
      { user_id: '25' },
    ]);
  });

  it('ATOMAR: hodisa yozilgandan keyin tranzaksiya yiqilsa — smena ochiq qoladi, outbox qatori ham YO`Q', async () => {
    const shiftId = await openShift('3');
    const original = realtime.shiftClosed.bind(realtime);
    jest
      .spyOn(realtime, 'shiftClosed')
      .mockImplementationOnce(async (shift, reason, manager) => {
        await original(shift, reason, manager);
        throw new Error('commit oldidan yiqildi');
      });

    await expect(
      finance.closeShift({ shift_id: shiftId, closed_by: '2' } as never),
    ).rejects.toBeDefined();

    expect(await rows()).toEqual([]);
    const shift = await db
      .getRepository(Shift)
      .findOneByOrFail({ id: shiftId });
    expect(shift.status).toBe(ShiftStatus.OPEN);
  });

  it('`RABBITMQ_GATEWAY_QUEUE` bo`sh — smena yopiladi, outbox`ga hech narsa yozilmaydi', async () => {
    build(false);
    const shiftId = await openShift('3');
    const res: any = await finance.closeShift({
      shift_id: shiftId,
      closed_by: '2',
    } as never);
    expect(res.data.status).toBe(ShiftStatus.CLOSED);
    expect(await rows()).toEqual([]);
  });

  it('kassa kartalari: yaratish, nom, o`tkazma (idempotent takror — yangi hodisa yo`q), konvertatsiya, arxiv → `finance.cashbox.card_changed`, faqat superadmin/admin', async () => {
    const created: any = await cards.createCard({
      name: 'Humo',
      created_by: '1',
    });
    const humoId = String(created.data.card.id);
    const list: any = await cards.listCards();
    const defaultId = String(
      list.data.cards.find((c: { is_default: boolean }) => c.is_default).id,
    );

    await cards.renameCard({ id: humoId, name: 'Humo 8600', updated_by: '1' });
    const transfer = {
      from_card_id: defaultId,
      to_card_id: humoId,
      amount: 1_000,
      comment: 'test',
      created_by: '1',
      dedup_epoch: 'rt-transfer-1',
    };
    const moved: any = await cards.transfer(transfer);
    const replay: any = await cards.transfer(transfer);
    expect(replay.data.idempotent).toBe(true);
    const converted: any = await cards.convert({
      type: CardMovementType.CARD_TO_CASH,
      card_id: humoId,
      amount: 1_000,
      comment: 'test',
      created_by: '1',
    });
    await cards.setCardActive({
      id: humoId,
      is_active: false,
      updated_by: '1',
    });

    const all = await rows();
    expect(all.map((r) => r.payload.event)).toEqual(
      Array(5).fill('finance.cashbox.card_changed'),
    );
    expect(all.map((r) => r.payload.payload.action)).toEqual([
      'created',
      'renamed',
      'transfer',
      'card_to_cash',
      'archived',
    ]);
    expect(all[2].payload.payload).toMatchObject({
      card_ids: [defaultId, humoId],
      movement_id: String(moved.data.movement.id),
    });
    expect(all[3].payload.payload).toMatchObject({
      card_ids: [humoId],
      movement_id: String(converted.data.movement.id),
    });
    for (const row of all) {
      expect([row.target, row.pattern]).toEqual(['GATEWAY', 'realtime.notify']);
      expect(row.payload.targets).toEqual([
        { role: 'superadmin' },
        { role: 'admin' },
      ]);
    }
  });

  it('rad etilgan karta amali (mablag` yetmaydi) — hodisa yo`q', async () => {
    const created: any = await cards.createCard({
      name: 'Uzcard',
      created_by: '1',
    });
    await expect(
      cards.convert({
        type: CardMovementType.CARD_TO_CASH,
        card_id: String(created.data.card.id),
        amount: 5_000,
        comment: 'test',
        created_by: '1',
      }),
    ).rejects.toBeDefined();
    expect((await rows()).map((r) => r.payload.payload.action)).toEqual([
      'created',
    ]);
  });
});
