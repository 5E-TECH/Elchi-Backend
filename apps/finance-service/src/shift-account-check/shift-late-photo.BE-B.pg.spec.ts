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
import { ShiftScheduleClaim } from '../entities/shift-schedule-claim.entity';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';
import { ShiftAccountCheckService } from './shift-account-check.service';
import { SHIFT_LATE_PHOTO_WINDOW_MS } from './shift-account-check.rules';

/**
 * BE-B (ega 2026-11-10: «24 soat ichida keyin yuklash») — HAQIQIY Postgres'da:
 * ASOSIY kassa smenasi `autoCloseShift` bilan yopiladi → hisobotda kartalar
 * `photo_status = pending` + `late_upload_deadline`; superadmin / admin rasmni
 * 24 soat ichida yuklaydi (farq — avto-yopish SNAPSHOT'i bo'yicha, qator
 * tasdiqlanadi, AI pending); qayta yuklashda eski AI natijasi e'tiborsiz;
 * AI natijasi yoziladi va `finance.shift.account_checked` (`late: true`);
 * 24 soatdan keyin 409 EXPIRED va `missing`; qo'lda yopilgan / ochiq — 409;
 * filial — 400; begona karta — 404; farq + izohsiz — 400; PUL INVARIANTI.
 * Env (`FINANCE_PG_TEST_URI`) berilmasa skip. Haqiqiy AI CHAQIRILMAYDI.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

type Rpc = { statusCode: number; message: string; data: any };
type RpcErr = {
  statusCode: number;
  message: string;
  code?: string;
  deadline?: string | null;
};

const rpcError = async (promise: Promise<unknown>): Promise<RpcErr> => {
  try {
    await promise;
  } catch (error) {
    return (error as { getError?: () => unknown }).getError?.() as RpcErr;
  }
  throw new Error('kutilgan xato chiqmadi');
};

const H = 3600_000;

describePg(
  'BE-B — avto-yopilgan MAIN smenaga karta rasmini keyin yuklash (Postgres)',
  () => {
    const schema = `spec_latephoto_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
          ShiftScheduleClaim,
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
      for (const level of ['warn', 'log', 'error'] as const) {
        jest
          .spyOn((service as any).logger, level)
          .mockImplementation(() => undefined);
      }
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

    beforeEach(async () => {
      outbox.enqueue.mockClear();
      activityLog.log.mockClear();
      for (const table of [
        'shift_account_checks',
        'shift_schedule_claims',
        'finance_settings',
        'cashbox_cards',
        'cashbox_history',
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
      // BE-A holati: MAIN kartalarida rasm + AI yoqiq.
      const flags = {
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
      };
      // Asosiy karta hosila qoldig'i: 300 000 − (100 000 + 50 000) = 150 000.
      const def = await repo.save(
        repo.create({
          cashbox_id: cashboxId,
          name: 'Asosiy karta',
          balance: 0,
          is_default: true,
          ...flags,
        }),
      );
      const humo = await repo.save(
        repo.create({
          cashbox_id: cashboxId,
          name: 'Humo',
          balance: 100_000,
          last4: '1234',
          sort_order: 1,
          ...flags,
        }),
      );
      const uzcard = await repo.save(
        repo.create({
          cashbox_id: cashboxId,
          name: 'Uzcard',
          balance: 50_000,
          last4: '5678',
          sort_order: 2,
          ...flags,
        }),
      );
      cards = { def, humo, uzcard };
      const shift = await db.getRepository(Shift).save(
        db.getRepository(Shift).create({
          opened_by: '25',
          cashbox_user_id: '0',
          status: ShiftStatus.OPEN,
          opened_at: new Date(Date.now() - 3 * H),
          opening_balance_cash: 200_000,
          opening_balance_card: 300_000,
        }),
      );
      shiftId = String(shift.id);
    });

    const autoClose = async (id = shiftId) => {
      const outcome = await service.autoCloseShift({
        shift_id: id,
        slot_key: '2026-11-10T22:00',
        slot_at: new Date(Date.now() - 60_000),
      });
      expect(outcome.closed).toBe(true);
      return db.getRepository(Shift).findOneByOrFail({ id });
    };

    const late = (
      cardId: string | number,
      entered: number | undefined,
      extra: Record<string, unknown> = {},
    ) =>
      checks.attachLatePhoto({
        shift_id: shiftId,
        card_id: String(cardId),
        photo_file_key: `shift-check-late-${randomUUID()}.jpg`,
        entered_balance: entered,
        requester_id: '1',
        requester_roles: ['superadmin'],
        ...extra,
      }) as Promise<Rpc>;

    const report = async (id = shiftId) => {
      const res = await service.getShiftReport({ shift_id: id });
      return {
        data: res.data,
        byCard: new Map<string, any>(
          res.data.accounts.map((row: any) => [row.card_id, row]),
        ),
      };
    };

    const row = (cardId: string | number, id = shiftId) =>
      db.getRepository(ShiftAccountCheck).findOneByOrFail({
        shift_id: id,
        cashbox_card_id: String(cardId),
      });

    const money = async () => ({
      cashbox: await db.query(
        `SELECT id, balance, balance_cash, balance_card FROM "${schema}".cashboxes ORDER BY id`,
      ),
      cards: await db.query(
        `SELECT id, balance FROM "${schema}".cashbox_cards ORDER BY id`,
      ),
      histories: await db.query(
        `SELECT COUNT(*)::int AS n FROM "${schema}".cashbox_history`,
      ),
      movements: await db.query(
        `SELECT COUNT(*)::int AS n FROM "${schema}".cashbox_card_movements`,
      ),
    });

    const realtimeEvents = (name: string) =>
      outbox.enqueue.mock.calls
        .map((call) => call[2] as { event: string; payload: any })
        .filter((msg) => msg.event === name);

    it('avto-yopilgan MAIN smena — hisobotda har karta `pending` + 24 soatlik muddat, `can_upload_late`', async () => {
      const closed = await autoClose();
      expect(closed.close_reason).toBe('auto');
      expect(closed.closed_by).toBeNull();
      const deadline = new Date(
        new Date(closed.closed_at as Date).getTime() +
          SHIFT_LATE_PHOTO_WINDOW_MS,
      ).toISOString();
      const { data, byCard } = await report();
      expect(data.close_reason).toBe('auto');
      expect(data.accounts).toHaveLength(3);
      for (const card of [cards.def, cards.humo, cards.uzcard]) {
        expect(byCard.get(String(card.id))).toEqual(
          expect.objectContaining({
            photo_file_key: null,
            photo_required_snap: true,
            confirmed_at: null,
            photo_status: 'pending',
            late_upload_deadline: deadline,
            late_uploaded: false,
            can_upload_late: true,
          }),
        );
      }
      expect(byCard.get(String(cards.humo.id)).expected_balance).toBe(100_000);
    });

    it('oyna ichida keyin yuklash — rasm / tasdiq / farq SNAPSHOT bo‘yicha, AI pending, realtime late, pul o‘zgarmaydi', async () => {
      const closed = await autoClose();
      // Smena yopilgandan keyin karta qoldig'i o'zgargan (keyingi operatsiyalar)
      // — farq baribir avto-yopish SNAPSHOT'i (100 000) bo'yicha hisoblanadi.
      await db.query(
        `UPDATE "${schema}".cashbox_cards SET balance = 777777 WHERE id = $1`,
        [cards.humo.id],
      );
      const shiftBefore = await db.query(
        `SELECT status, closed_at, closing_balance_card, expected_balance_card, discrepancy_card, close_reason, closed_by FROM "${schema}".shifts WHERE id = $1`,
        [shiftId],
      );
      const before = await money();
      outbox.enqueue.mockClear();

      const res = await late(cards.humo.id, 99_000, {
        comment: 'Kassir yuklamagan — bank ilovasidan',
      });
      expect(res.statusCode).toBe(201);
      expect(res.data.ai_enabled).toBe(true);
      expect(res.data.ai_request_id).toEqual(expect.any(String));
      expect(res.data.previous_photo_file_key).toBeNull();
      expect(res.data.check).toEqual(
        expect.objectContaining({
          card_id: String(cards.humo.id),
          expected_balance: 100_000,
          entered_balance: 99_000,
          difference: -1_000,
          comment: 'Kassir yuklamagan — bank ilovasidan',
          comment_required: true,
          ai_status: 'pending',
          ai_enabled_snap: true,
          confirmed_by: '1',
          photo_status: 'uploaded',
          late_uploaded: true,
          can_upload_late: true,
        }),
      );

      const saved = await row(cards.humo.id);
      expect(saved.photo_file_key).toMatch(/^shift-check-late-/);
      expect(String(saved.photo_uploaded_by)).toBe('1');
      expect(String(saved.confirmed_by)).toBe('1');
      expect(saved.confirmed_at).toBeInstanceOf(Date);
      expect(saved.photo_uploaded_at!.getTime()).toBeGreaterThan(
        new Date(closed.closed_at as Date).getTime(),
      );
      expect(saved.ai_request_id).toBe(res.data.ai_request_id);
      expect(saved.expected_balance).toBe(100_000);
      expect(saved.difference).toBe(-1_000);

      // Hisobot: shu qator uploaded, qolganlari hali pending.
      const { byCard } = await report();
      expect(byCard.get(String(cards.humo.id))).toEqual(
        expect.objectContaining({
          photo_status: 'uploaded',
          late_uploaded: true,
          confirmed_by: '1',
        }),
      );
      expect(byCard.get(String(cards.uzcard.id)).photo_status).toBe('pending');

      // Activity-log.
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'finance.shift_late_photo_uploaded',
          entity_type: 'ShiftAccountCheck',
          user_id: '1',
          metadata: expect.objectContaining({
            shift_id: shiftId,
            card_id: String(cards.humo.id),
            entered: 99_000,
            expected: 100_000,
            difference: -1_000,
          }),
        }),
      );
      // Realtime: o'sha `finance.shift.account_checked`, `late: true`, summasiz.
      const events = realtimeEvents('finance.shift.account_checked');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual(
        expect.objectContaining({
          shift_id: shiftId,
          cashbox_type: 'main',
          card_id: String(cards.humo.id),
          ai_status: 'pending',
          late: true,
        }),
      );
      expect(JSON.stringify(events[0].payload)).not.toMatch(/99000|100000/);

      // ⚠️ PUL INVARIANTI: balanslar, tarix, karta harakatlari va smena qatori.
      expect(await money()).toEqual(before);
      expect(
        await db.query(
          `SELECT status, closed_at, closing_balance_card, expected_balance_card, discrepancy_card, close_reason, closed_by FROM "${schema}".shifts WHERE id = $1`,
          [shiftId],
        ),
      ).toEqual(shiftBefore);
    });

    it('qayta yuklash — oxirgisi yutadi, eski AI natijasi e’tiborsiz; yangisi snapshot bilan solishtiriladi va hodisa chiqadi', async () => {
      await autoClose();
      const first = await late(cards.humo.id, 100_000);
      const second = await late(cards.humo.id, 100_000);
      expect(second.data.ai_request_id).not.toBe(first.data.ai_request_id);
      expect(second.data.previous_photo_file_key).toEqual(
        expect.stringMatching(/^shift-check-late-/),
      );
      // Joriy karta qoldig'i o'zgargan — AI baribir SNAPSHOT (100 000) bilan.
      await db.query(
        `UPDATE "${schema}".cashbox_cards SET balance = 150000 WHERE id = $1`,
        [cards.humo.id],
      );
      outbox.enqueue.mockClear();

      const stale = await checks.applyAiResult({
        shift_id: shiftId,
        card_id: String(cards.humo.id),
        ai_request_id: first.data.ai_request_id,
        result: { ok: true, balance: 1, last4: '1234', confidence: 1 },
      });
      expect(stale.data.applied).toBe(false);
      expect((await row(cards.humo.id)).ai_status).toBe('pending');
      expect(realtimeEvents('finance.shift.account_checked')).toHaveLength(0);

      const applied = await checks.applyAiResult({
        shift_id: shiftId,
        card_id: String(cards.humo.id),
        ai_request_id: second.data.ai_request_id,
        result: {
          ok: true,
          balance: 100_000,
          last4: '1234',
          confidence: 0.95,
          model: 'mock',
        },
      });
      expect(applied.data.applied).toBe(true);
      expect(applied.data.check).toEqual(
        expect.objectContaining({
          ai_status: 'match',
          ai_entered_ok: true,
          ai_read_balance: 100_000,
          photo_status: 'uploaded',
          late_uploaded: true,
        }),
      );
      // Yopilgan smena qatori rad etilmaydi — natija yozildi va hodisa chiqdi.
      const events = realtimeEvents('finance.shift.account_checked');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual(
        expect.objectContaining({
          shift_id: shiftId,
          card_id: String(cards.humo.id),
          ai_status: 'match',
          late: true,
        }),
      );
      const { byCard } = await report();
      expect(byCard.get(String(cards.humo.id))).toEqual(
        expect.objectContaining({ ai_status: 'match', difference: 0 }),
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'finance.shift_account_ai_checked' }),
      );
    });

    it('24 soatdan keyin — 409 SHIFT_LATE_PHOTO_EXPIRED (`deadline`), hisobotda `missing`; 23 soatda hali ruxsat', async () => {
      await autoClose();
      const setClosedAt = (ms: number) =>
        db.query(`UPDATE "${schema}".shifts SET closed_at = $1 WHERE id = $2`, [
          new Date(Date.now() - ms),
          shiftId,
        ]);
      await setClosedAt(23 * H);
      expect((await late(cards.def.id, 150_000)).statusCode).toBe(201);

      await setClosedAt(25 * H);
      const closedAt = (
        await db.getRepository(Shift).findOneByOrFail({ id: shiftId })
      ).closed_at as Date;
      const deadline = new Date(
        closedAt.getTime() + SHIFT_LATE_PHOTO_WINDOW_MS,
      ).toISOString();
      const err = await rpcError(late(cards.humo.id, 100_000));
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 409,
          code: 'SHIFT_LATE_PHOTO_EXPIRED',
          message:
            "Rasmni keyin yuklash muddati tugagan (smena yopilganidan 24 soat o'tdi)",
          deadline,
        }),
      );
      const untouched = await row(cards.humo.id);
      expect(untouched.photo_file_key).toBeNull();
      expect(untouched.confirmed_at).toBeNull();

      const { byCard } = await report();
      expect(byCard.get(String(cards.humo.id))).toEqual(
        expect.objectContaining({
          photo_status: 'missing',
          late_upload_deadline: deadline,
          can_upload_late: false,
        }),
      );
      // Oyna ichida yuklangani — uploaded qoladi.
      expect(byCard.get(String(cards.def.id))).toEqual(
        expect.objectContaining({
          photo_status: 'uploaded',
          late_uploaded: true,
          can_upload_late: false,
        }),
      );
    });

    it('qo‘lda yopilgan smena — 409 SHIFT_LATE_PHOTO_NOT_AUTO_CLOSED; hisobotda muddat yo‘q', async () => {
      for (const card of [cards.def, cards.humo, cards.uzcard]) {
        await checks.attachPhoto({
          card_id: String(card.id),
          photo_file_key: `shift-check-${randomUUID()}.jpg`,
          requester_id: '25',
        });
      }
      const closed = await service.closeShift({
        shift_id: shiftId,
        closed_by: '25',
        closing_balance_cash: 200_000,
        accounts: [
          { card_id: String(cards.def.id), entered_balance: 150_000 },
          { card_id: String(cards.humo.id), entered_balance: 100_000 },
          { card_id: String(cards.uzcard.id), entered_balance: 50_000 },
        ],
      });
      expect(closed.data.status).toBe(ShiftStatus.CLOSED);
      const err = await rpcError(late(cards.humo.id, 100_000));
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 409,
          code: 'SHIFT_LATE_PHOTO_NOT_AUTO_CLOSED',
          message: 'Rasmni keyin yuklash faqat avtomatik yopilgan smena uchun',
        }),
      );
      const { byCard } = await report();
      expect(byCard.get(String(cards.humo.id))).toEqual(
        expect.objectContaining({
          photo_status: 'uploaded',
          late_upload_deadline: null,
          late_uploaded: false,
          can_upload_late: false,
        }),
      );
    });

    it('ochiq smena — 409 NOT_AUTO_CLOSED; qoralama: rasm talab qilingan, yo‘q → `pending`', async () => {
      await checks.attachPhoto({
        card_id: String(cards.humo.id),
        photo_file_key: 'shift-check-draft.jpg',
        requester_id: '25',
      });
      const err = await rpcError(late(cards.humo.id, 100_000));
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('SHIFT_LATE_PHOTO_NOT_AUTO_CLOSED');
      expect((await row(cards.humo.id)).photo_file_key).toBe(
        'shift-check-draft.jpg',
      );
      // Rasmsiz qoralama qatori (masalan rasm keyin o'chirilgan).
      await db.getRepository(ShiftAccountCheck).save(
        db.getRepository(ShiftAccountCheck).create({
          shift_id: shiftId,
          cashbox_card_id: String(cards.uzcard.id),
          photo_required_snap: true,
        }),
      );
      const { byCard } = await report();
      expect(byCard.get(String(cards.humo.id))).toEqual(
        expect.objectContaining({
          photo_status: 'uploaded',
          late_upload_deadline: null,
          can_upload_late: false,
        }),
      );
      expect(byCard.get(String(cards.uzcard.id))).toEqual(
        expect.objectContaining({
          photo_status: 'pending',
          late_upload_deadline: null,
          can_upload_late: false,
        }),
      );
    });

    it('filial smenasi (avto-yopilgan bo‘lsa ham) — 400 SHIFT_LATE_PHOTO_MAIN_ONLY', async () => {
      const branchCashbox = await db.getRepository(Cashbox).save(
        db.getRepository(Cashbox).create({
          user_id: '13',
          cashbox_type: Cashbox_type.BRANCH,
          balance: 50_000,
          balance_cash: 30_000,
          balance_card: 20_000,
        } as Partial<Cashbox>),
      );
      const branchCard = await db.getRepository(CashboxCard).save(
        db.getRepository(CashboxCard).create({
          cashbox_id: String(branchCashbox.id),
          name: 'Filial Humo',
          balance: 20_000,
          sort_order: 1,
        }),
      );
      const branchShift = await db.getRepository(Shift).save(
        db.getRepository(Shift).create({
          opened_by: '26',
          cashbox_user_id: '13',
          status: ShiftStatus.OPEN,
          opened_at: new Date(Date.now() - 3 * H),
        }),
      );
      // Filial: qoralama (rasm) → avto-yopishda qator yoziladi.
      await checks.attachPhoto({
        card_id: String(branchCard.id),
        photo_file_key: 'shift-check-branch.jpg',
        entered_balance: 20_000,
        requester_id: '26',
        cashbox_user_id: '13',
      });
      await autoClose(String(branchShift.id));
      const err = await rpcError(
        late(branchCard.id, 20_000, { shift_id: String(branchShift.id) }),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          code: 'SHIFT_LATE_PHOTO_MAIN_ONLY',
          message: 'Rasmni keyin yuklash faqat asosiy kassa smenasi uchun',
        }),
      );
      const { byCard } = await report(String(branchShift.id));
      expect(byCard.get(String(branchCard.id))).toEqual(
        expect.objectContaining({
          late_upload_deadline: null,
          can_upload_late: false,
        }),
      );
    });

    it('smena yo‘q — 404; smenada qatori yo‘q karta — 404 SHIFT_LATE_PHOTO_CARD_NOT_IN_SHIFT', async () => {
      const noShift = await rpcError(
        late(cards.humo.id, 100_000, { shift_id: '999999' }),
      );
      expect(noShift).toEqual(
        expect.objectContaining({
          statusCode: 404,
          message: 'Smena topilmadi',
        }),
      );
      expect(noShift.code).toBeUndefined();

      await autoClose();
      const unknown = await rpcError(late('999999', 100_000));
      expect(unknown).toEqual(
        expect.objectContaining({
          statusCode: 404,
          code: 'SHIFT_LATE_PHOTO_CARD_NOT_IN_SHIFT',
          message: "Bu karta shu smena hisobotida yo'q",
        }),
      );
      // Avto-yopishdan keyin yaratilgan karta — snapshot qatori yo'q.
      const newer = await db.getRepository(CashboxCard).save(
        db.getRepository(CashboxCard).create({
          cashbox_id: cashboxId,
          name: 'Yangi karta',
          balance: 0,
          sort_order: 3,
        }),
      );
      const notInShift = await rpcError(late(newer.id, 0));
      expect(notInShift.code).toBe('SHIFT_LATE_PHOTO_CARD_NOT_IN_SHIFT');
    });

    it('farq bor, izoh yo‘q — 400 (yopishdagi matn), qator o‘zgarmaydi; farqsiz — izohsiz ham o‘tadi', async () => {
      await autoClose();
      const err = await rpcError(late(cards.humo.id, 90_000));
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: '«Humo»: farq bor yoki AI natijasi mos emas — izoh majburiy',
        }),
      );
      const untouched = await row(cards.humo.id);
      expect(untouched.photo_file_key).toBeNull();
      expect(untouched.entered_balance).toBeNull();
      expect(untouched.confirmed_at).toBeNull();
      expect(activityLog.log).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'finance.shift_late_photo_uploaded',
        }),
      );

      // Farq 0 (Asosiy karta hosila snapshot'i 150 000) — izoh shart emas.
      const ok = await late(cards.def.id, 150_000);
      expect(ok.data.check).toEqual(
        expect.objectContaining({ difference: 0, comment_required: false }),
      );
    });

    it('kirish: faqat superadmin / admin (finance ham tekshiradi); entered_balance majburiy; AI o‘chiq — `disabled`', async () => {
      await autoClose();
      const denied = await rpcError(
        late(cards.humo.id, 100_000, { requester_roles: ['registrator'] }),
      );
      expect(denied.statusCode).toBe(403);
      const missing = await rpcError(late(cards.humo.id, undefined));
      expect(missing).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: 'entered_balance majburiy',
        }),
      );
      const negative = await rpcError(late(cards.humo.id, -5));
      expect(negative.statusCode).toBe(400);

      await checks.updateSettings({
        requester_id: '1',
        requester_roles: ['superadmin'],
        ai_check_enabled: false,
      });
      const res = await late(cards.humo.id, 100_000, {
        requester_roles: ['admin'],
        requester_id: '2',
      });
      expect(res.data.ai_enabled).toBe(false);
      expect(res.data.ai_request_id).toBeNull();
      expect(res.data.check).toEqual(
        expect.objectContaining({
          ai_status: 'disabled',
          ai_enabled_snap: false,
          confirmed_by: '2',
          photo_status: 'uploaded',
        }),
      );
    });
  },
);
