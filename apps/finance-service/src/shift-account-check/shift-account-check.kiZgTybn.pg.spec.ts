import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { Cashbox_type } from '@app/common';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { Shift, ShiftStatus } from '../entities/shift.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { CashboxCardMovement } from '../entities/cashbox-card-movement.entity';
import { ShiftAccountCheck } from '../entities/shift-account-check.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';
import { ShiftAccountCheckService } from './shift-account-check.service';

/**
 * kiZgTybn — HAQIQIY Postgres'da smena yopishda karta qoldig'ini tasdiqlash:
 * 3 karta (biri AI mos, biri mos emas, biri AI o'chiq) → hisobotda to'g'ri
 * holatlar; AI o'chiq / AI xatosi yopishni bloklamaydi; rasm majburiy → 400;
 * farq / mismatch → izoh majburiy; sozlamalar faqat superadmin; eski AI
 * natijasi e'tiborsiz; PUL INVARIANTI (balanslar o'zgarmaydi).
 * Env (`FINANCE_PG_TEST_URI`) berilmasa skip. Haqiqiy AI CHAQIRILMAYDI —
 * AI javobi `applyAiResult` ga qo'lda beriladi (gateway fon vazifasi o'rniga).
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

type Rpc = { statusCode: number; data: any };

const rpcError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { getError?: () => unknown }).getError?.() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('kutilgan xato chiqmadi');
};

describePg('kiZgTybn — smena yopishda karta qoldiqlari (Postgres)', () => {
  const schema = `spec_shiftacc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;
  let checks: ShiftAccountCheckService;
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    process.env.SHIFT_CLOSE_AI_WAIT_MS = '0';
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
        ShiftAccountCheck,
        FinanceSetting,
      ],
      synchronize: true,
      extra: { max: 5 },
    });
    await db.initialize();
    const realtime = new FinanceRealtimeService(
      outbox as never,
      { get: () => 'gateway_queue' } as never,
    );
    checks = new ShiftAccountCheckService(db, activityLog as never, realtime);
    service = new FinanceServiceService(
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
      { send: jest.fn(() => of({ statusCode: 200, data: [] })) } as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
      undefined,
      undefined,
      undefined,
      realtime,
      checks,
    );
    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
  }, 30_000);

  afterAll(async () => {
    delete process.env.SHIFT_CLOSE_AI_WAIT_MS;
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  let shiftId: string;
  let cashboxId: string;
  let cards: { def: CashboxCard; humo: CashboxCard; uzcard: CashboxCard };

  const setSettings = (patch: Record<string, unknown>) =>
    checks.updateSettings({
      requester_id: '1',
      requester_roles: ['superadmin'],
      ...patch,
    }) as Promise<Rpc>;

  beforeEach(async () => {
    outbox.enqueue.mockClear();
    activityLog.log.mockClear();
    for (const table of [
      'shift_account_checks',
      'finance_settings',
      'cashbox_cards',
      'shifts',
      'cashboxes',
    ]) {
      await db.query(
        `TRUNCATE TABLE "${schema}"."${table}" RESTART IDENTITY CASCADE`,
      );
    }
    const cashbox = await db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        balance: 500_000,
        balance_cash: 200_000,
        balance_card: 300_000,
      } as Partial<Cashbox>),
    );
    cashboxId = String(cashbox.id);
    const repo = db.getRepository(CashboxCard);
    const def = await repo.save(
      repo.create({
        cashbox_id: cashboxId,
        name: 'Asosiy karta',
        balance: 0,
        is_default: true,
      }),
    );
    // Asosiy karta hosila qoldig'i: 300 000 − (100 000 + 50 000) = 150 000.
    const humo = await repo.save(
      repo.create({
        cashbox_id: cashboxId,
        name: 'Humo',
        balance: 100_000,
        last4: '1234',
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
        sort_order: 1,
      }),
    );
    const uzcard = await repo.save(
      repo.create({
        cashbox_id: cashboxId,
        name: 'Uzcard',
        balance: 50_000,
        last4: '5678',
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
        sort_order: 2,
      }),
    );
    cards = { def, humo, uzcard };
    const shift = await db.getRepository(Shift).save(
      db.getRepository(Shift).create({
        opened_by: '25',
        cashbox_user_id: '0',
        status: ShiftStatus.OPEN,
        opened_at: new Date(Date.now() - 3_600_000),
        opening_balance_cash: 200_000,
        opening_balance_card: 300_000,
      }),
    );
    shiftId = String(shift.id);
  });

  const attach = (cardId: string, entered?: number) =>
    checks.attachPhoto({
      card_id: cardId,
      photo_file_key: `shift-check-${cardId}-${randomUUID()}.jpg`,
      entered_balance: entered,
      requester_id: '25',
    }) as Promise<Rpc>;

  const balancesSnapshot = async () => ({
    cashbox: await db.query(
      `SELECT balance, balance_cash, balance_card FROM "${schema}".cashboxes ORDER BY id`,
    ),
    cards: await db.query(
      `SELECT id, balance FROM "${schema}".cashbox_cards ORDER BY id`,
    ),
  });

  it('TC: 3 karta — mos / mos emas / AI o‘chiq → hisobotda to‘g‘ri holatlar, balanslar o‘zgarmaydi', async () => {
    await setSettings({
      account_check_enabled: true,
      ai_check_enabled: true,
      cards: [{ card_id: String(cards.def.id), ai_check_enabled: false }],
    });
    const before = await balancesSnapshot();

    const humo = await attach(String(cards.humo.id), 100_000);
    expect(humo.data.ai_enabled).toBe(true);
    expect(humo.data.check.ai_status).toBe('pending');
    expect(humo.data.check.expected_balance).toBe(100_000);
    const uz = await attach(String(cards.uzcard.id), 50_000);
    expect(uz.data.check.ai_status).toBe('pending');

    // AI natijalari (mock): Humo — mos, Uzcard — rasmda boshqa summa.
    const r1 = (await checks.applyAiResult({
      shift_id: shiftId,
      card_id: String(cards.humo.id),
      ai_request_id: humo.data.ai_request_id,
      result: {
        ok: true,
        balance: 100_000.5,
        last4: '1234',
        // Sana matniga aralashgan guruhlangan karta raqami — niqoblanadi.
        date: '30.10.2026 14.05 8600 1234 5678 9012',
        confidence: 0.95,
        model: 'mock',
      },
    })) as Rpc;
    expect(r1.data.check.ai_status).toBe('match');
    const humoRow = await db.getRepository(ShiftAccountCheck).findOneByOrFail({
      shift_id: shiftId,
      cashbox_card_id: String(cards.humo.id),
    });
    expect(humoRow.ai_date_detected).toBe('30.10.2026 14.05 ***');
    expect(JSON.stringify(humoRow.ai_raw)).not.toMatch(/8600|5678|9012/);
    expect(r1.data.check.ai_entered_ok).toBe(true);
    const r2 = (await checks.applyAiResult({
      shift_id: shiftId,
      card_id: String(cards.uzcard.id),
      ai_request_id: uz.data.ai_request_id,
      result: {
        ok: true,
        balance: 45_000,
        last4: '5678',
        confidence: 0.9,
        model: 'mock',
      },
    })) as Rpc;
    expect(r2.data.check.ai_status).toBe('mismatch');
    expect(r2.data.check.ai_entered_ok).toBe(false);

    // Realtime: har AI natijasi — finance.shift.account_checked.
    const events = outbox.enqueue.mock.calls.map((call) => call[2]);
    const checked = events.filter(
      (msg) => msg.event === 'finance.shift.account_checked',
    );
    expect(checked).toHaveLength(2);
    expect(checked[0].payload).toEqual(
      expect.objectContaining({
        shift_id: shiftId,
        card_id: String(cards.humo.id),
        ai_status: 'match',
      }),
    );

    // Uzcard — mismatch: izohsiz yopish 400, smena ochiq qoladi.
    const accounts = [
      { card_id: String(cards.def.id), entered_balance: 150_000 },
      { card_id: String(cards.humo.id), entered_balance: 100_000 },
      { card_id: String(cards.uzcard.id), entered_balance: 50_000 },
    ];
    const err = await rpcError(
      service.closeShift({
        shift_id: shiftId,
        closed_by: '25',
        closing_balance_cash: 200_000,
        accounts,
      }),
    );
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('Uzcard');
    expect(err.message).toContain('izoh majburiy');
    expect(
      (await db.getRepository(Shift).findOneByOrFail({ id: shiftId })).status,
    ).toBe(ShiftStatus.OPEN);

    accounts[2] = {
      ...accounts[2],
      comment: 'Ilova eski qoldiqni ko‘rsatdi',
    } as never;
    const closed = (await service.closeShift({
      shift_id: shiftId,
      closed_by: '25',
      closing_balance_cash: 200_000,
      accounts,
    })) as Rpc;
    expect(closed.data.status).toBe(ShiftStatus.CLOSED);
    expect(closed.data.accounts_check).toEqual(
      expect.objectContaining({
        total: 3,
        match: 1,
        mismatch: 1,
        not_required: 1,
      }),
    );

    const report = (await service.getShiftReport({ shift_id: shiftId })) as Rpc;
    const byCard = new Map<string, any>(
      report.data.accounts.map((row: any) => [row.card_id, row]),
    );
    expect(byCard.get(String(cards.humo.id))).toEqual(
      expect.objectContaining({
        ai_status: 'match',
        difference: 0,
        ai_entered_ok: true,
      }),
    );
    expect(byCard.get(String(cards.uzcard.id))).toEqual(
      expect.objectContaining({
        ai_status: 'mismatch',
        ai_read_balance: 45_000,
        comment: 'Ilova eski qoldiqni ko‘rsatdi',
        comment_required: true,
      }),
    );
    // Asosiy karta: hosila qoldiq snapshot'i, AI o'chiq.
    expect(byCard.get(String(cards.def.id))).toEqual(
      expect.objectContaining({
        ai_status: 'not_required',
        expected_balance: 150_000,
        difference: 0,
        ai_enabled_snap: false,
      }),
    );
    expect(report.data.cash.closing_balance).toBe(200_000);
    expect(report.data.accounts_summary).toEqual(
      expect.objectContaining({ total: 3, match: 1, mismatch: 1 }),
    );

    // PUL INVARIANTI: tasdiqlash balanslarga tegmaydi.
    expect(await balancesSnapshot()).toEqual(before);
  });

  it('TC: AI o‘chiq (global) — rasm yuklanadi, AI chaqirilmaydi, yopish ishlaydi', async () => {
    await setSettings({ account_check_enabled: true, ai_check_enabled: false });
    const humo = await attach(String(cards.humo.id), 100_000);
    expect(humo.data.ai_enabled).toBe(false);
    expect(humo.data.ai_request_id).toBeNull();
    expect(humo.data.check.ai_status).toBe('disabled');
    await attach(String(cards.uzcard.id), 50_000);
    const closed = (await service.closeShift({
      shift_id: shiftId,
      closed_by: '25',
      closing_balance_cash: 200_000,
      accounts: [
        { card_id: String(cards.def.id), entered_balance: 150_000 },
        { card_id: String(cards.humo.id), entered_balance: 100_000 },
        { card_id: String(cards.uzcard.id), entered_balance: 50_000 },
      ],
    })) as Rpc;
    expect(closed.data.status).toBe(ShiftStatus.CLOSED);
    expect(closed.data.accounts_check.disabled).toBe(2);
  });

  it('TC: AI xatosi smenani bloklamaydi (error), pending esa kutish tugagach yopiladi', async () => {
    await setSettings({ ai_check_enabled: true });
    const humo = await attach(String(cards.humo.id), 100_000);
    await checks.applyAiResult({
      shift_id: shiftId,
      card_id: String(cards.humo.id),
      ai_request_id: humo.data.ai_request_id,
      result: { ok: false, reason: 'network' },
    });
    // Uzcard — AI javobi umuman kelmadi (pending).
    await attach(String(cards.uzcard.id), 50_000);
    const closed = (await service.closeShift({
      shift_id: shiftId,
      closed_by: '25',
      closing_balance_cash: 200_000,
      accounts: [
        { card_id: String(cards.humo.id), entered_balance: 100_000 },
        { card_id: String(cards.uzcard.id), entered_balance: 50_000 },
      ],
    })) as Rpc;
    expect(closed.data.status).toBe(ShiftStatus.CLOSED);
    expect(closed.data.accounts_check).toEqual(
      expect.objectContaining({ error: 1, pending: 1 }),
    );
    // Kechikkan natija smena yopilgandan keyin ham hisobotga yoziladi.
    const row = await db.getRepository(ShiftAccountCheck).findOneByOrFail({
      shift_id: shiftId,
      cashbox_card_id: String(cards.uzcard.id),
    });
    const late = (await checks.applyAiResult({
      shift_id: shiftId,
      card_id: String(cards.uzcard.id),
      ai_request_id: row.ai_request_id,
      result: { ok: true, balance: 50_000, last4: '5678', confidence: 0.9 },
    })) as Rpc;
    expect(late.data.check.ai_status).toBe('match');
  });

  it('TC: rasm majburiy kartada rasm yo‘q → 400; hamma karta tasdiqlanmasa → 400', async () => {
    await setSettings({ account_check_enabled: true });
    const missingPhoto = await rpcError(
      service.closeShift({
        shift_id: shiftId,
        closed_by: '25',
        closing_balance_cash: 200_000,
        accounts: [
          { card_id: String(cards.def.id), entered_balance: 150_000 },
          { card_id: String(cards.humo.id), entered_balance: 100_000 },
          { card_id: String(cards.uzcard.id), entered_balance: 50_000 },
        ],
      }),
    );
    expect(missingPhoto.statusCode).toBe(400);
    expect(missingPhoto.message).toContain('rasm');

    const missingCard = await rpcError(
      service.closeShift({
        shift_id: shiftId,
        closed_by: '25',
        closing_balance_cash: 200_000,
        accounts: [{ card_id: String(cards.def.id), entered_balance: 150_000 }],
      }),
    );
    expect(missingCard.statusCode).toBe(400);
    expect(missingCard.message).toContain('Humo');

    // Global rasm master kaliti o'chirilsa — rasm talab qilinmaydi.
    await setSettings({ photo_required: false });
    const closed = (await service.closeShift({
      shift_id: shiftId,
      closed_by: '25',
      closing_balance_cash: 200_000,
      accounts: [
        { card_id: String(cards.def.id), entered_balance: 150_000 },
        { card_id: String(cards.humo.id), entered_balance: 100_000 },
        {
          card_id: String(cards.uzcard.id),
          entered_balance: 40_000,
          comment: 'kamomad',
        },
      ],
    })) as Rpc;
    expect(closed.data.status).toBe(ShiftStatus.CLOSED);
    const uz = await db.getRepository(ShiftAccountCheck).findOneByOrFail({
      shift_id: shiftId,
      cashbox_card_id: String(cards.uzcard.id),
    });
    expect(uz.difference).toBe(-10_000);
  });

  it('TC: tasdiqlash o‘chiq va accounts yo‘q — avvalgi yopish oqimi o‘zgarmaydi', async () => {
    const closed = (await service.closeShift({
      shift_id: shiftId,
      closed_by: '25',
      closing_balance_cash: 200_000,
    })) as Rpc;
    expect(closed.data.status).toBe(ShiftStatus.CLOSED);
    expect(closed.data.accounts_check).toBeUndefined();
  });

  it('TC: begona kalit / begona karta / yopilgan smena / eski AI natijasi', async () => {
    const foreignKey = await rpcError(
      service.closeShift({
        shift_id: shiftId,
        closed_by: '25',
        closing_balance_cash: 200_000,
        accounts: [
          {
            card_id: String(cards.def.id),
            entered_balance: 150_000,
            photo_file_key: 'proof-boshqa.jpg',
          },
        ],
      }),
    );
    expect(foreignKey.statusCode).toBe(400);

    const foreignCard = await rpcError(
      service.closeShift({
        shift_id: shiftId,
        closed_by: '25',
        closing_balance_cash: 200_000,
        accounts: [{ card_id: '9999', entered_balance: 1 }],
      }),
    );
    expect(foreignCard.statusCode).toBe(400);

    // Menejer doirasi: boshqa filial — 403.
    const scoped = await rpcError(
      checks.attachPhoto({
        card_id: String(cards.humo.id),
        photo_file_key: 'shift-check-x.jpg',
        requester_id: '25',
        cashbox_user_id: '13',
      }),
    );
    expect(scoped.statusCode).toBe(403);

    await setSettings({ ai_check_enabled: true });
    const first = await attach(String(cards.humo.id), 100_000);
    const second = await attach(String(cards.humo.id), 100_000);
    expect(second.data.previous_photo_file_key).toBeTruthy();
    const stale = (await checks.applyAiResult({
      shift_id: shiftId,
      card_id: String(cards.humo.id),
      ai_request_id: first.data.ai_request_id,
      result: { ok: true, balance: 1, last4: '1234', confidence: 1 },
    })) as Rpc;
    expect(stale.data.applied).toBe(false);

    await service.closeShift({
      shift_id: shiftId,
      closed_by: '25',
      closing_balance_cash: 200_000,
    });
    // Ochiq smena yo'q — 404; aniq yopilgan smena — 400.
    const noOpen = await rpcError(attach(String(cards.uzcard.id)));
    expect(noOpen.statusCode).toBe(404);
    const closedErr = await rpcError(
      checks.attachPhoto({
        shift_id: shiftId,
        card_id: String(cards.uzcard.id),
        photo_file_key: 'shift-check-y.jpg',
        requester_id: '25',
      }),
    );
    expect(closedErr.statusCode).toBe(400);
  });

  it('TC: sozlamalar — faqat superadmin; AI rasmsiz yoqilmaydi; GET karta bayroqlari', async () => {
    const denied = await rpcError(
      checks.updateSettings({
        requester_id: '2',
        requester_roles: ['admin'],
        ai_check_enabled: true,
      }),
    );
    expect(denied.statusCode).toBe(403);
    const aiNoPhoto = await rpcError(
      setSettings({
        cards: [{ card_id: String(cards.def.id), ai_check_enabled: true }],
      }),
    );
    expect(aiNoPhoto.statusCode).toBe(400);

    await setSettings({ ai_check_enabled: true, account_check_enabled: true });
    const got = (await checks.getSettings({ cashbox_user_id: '0' })) as Rpc;
    expect(got.data).toEqual(
      expect.objectContaining({
        account_check_enabled: true,
        photo_required: true,
        ai_check_enabled: true,
      }),
    );
    const humo = got.data.cards.find(
      (c: any) => c.card_id === String(cards.humo.id),
    );
    expect(humo).toEqual(
      expect.objectContaining({ photo_required: true, ai_enabled: true }),
    );
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'finance.shift_settings_updated' }),
    );
  });

  it('TC: hisobot doirasi — boshqa kassa smenasi 404', async () => {
    const err = await rpcError(
      service.getShiftReport({ shift_id: shiftId, cashbox_user_id: '13' }),
    );
    expect(err.statusCode).toBe(404);
  });
});
