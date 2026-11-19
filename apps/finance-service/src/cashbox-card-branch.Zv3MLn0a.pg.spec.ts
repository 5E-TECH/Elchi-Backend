import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { Cashbox_type, PaymentMethod, Source_type } from '@app/common';
import { CreateCashboxCards1716000000105 } from '../../../migrations/1716000000105-CreateCashboxCards';
import { CashboxCardDetails1716000000161 } from '../../../migrations/1716000000161-CashboxCardDetails';
import { FinanceServiceService } from './finance-service.service';
import { CashboxCardService } from './cashbox-card/cashbox-card.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift } from './entities/shift.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import {
  CardMovementType,
  CashboxCardMovement,
} from './entities/cashbox-card-movement.entity';

/**
 * Zv3MLn0a — kassa kartalari / hisob raqamlari: tafsilotlar (turi, bank,
 * FAQAT oxirgi 4 raqam, egasi), smena sozlamalari (faqat superadmin), FILIAL
 * kassalariga kengaytirish, menejer doirasi, make-default. HAQIQIY Postgres
 * (alohida vaqtinchalik baza; karta jadvallari FAQAT migratsiya 105 + 161).
 *
 * INVARIANT har kassa uchun alohida: Σ(kassa kartalari) == shu kassaning
 * `balance_card`; balance == naqd + karta.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const BRANCH = '13';
const OTHER_BRANCH = '14';

describePg(
  'Zv3MLn0a — filial kassasi kartalari va tafsilotlar, haqiqiy Postgres',
  () => {
    const dbName = `spec_zv3_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    let admin: DataSource;
    let db: DataSource;
    let cards: CashboxCardService;
    let finance: FinanceServiceService;
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const realtime = {
      cashboxCardChanged: jest.fn().mockResolvedValue(undefined),
    };
    const base105 = new CreateCashboxCards1716000000105();
    const details161 = new CashboxCardDetails1716000000161();
    const ORIGINAL_ENV = process.env.FINANCE_REQUIRE_OPEN_SHIFT;

    const dbUrl = () => {
      const url = new URL(pgUri!);
      url.pathname = `/${dbName}`;
      return url.toString();
    };

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: pgUri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);

      const base = new DataSource({
        type: 'postgres',
        url: dbUrl(),
        schema: 'finance_schema',
        entities: [Cashbox, CashboxHistory, Shift],
        synchronize: false,
      });
      await base.initialize();
      await base.query('CREATE SCHEMA IF NOT EXISTS "finance_schema"');
      await base.synchronize();
      await base.query(
        'ALTER TABLE "finance_schema"."cashbox_history" DROP COLUMN "card_id"',
      );
      await base.destroy();

      db = new DataSource({
        type: 'postgres',
        url: dbUrl(),
        schema: 'finance_schema',
        entities: [
          Cashbox,
          CashboxHistory,
          Shift,
          CashboxCard,
          CashboxCardMovement,
        ],
        synchronize: false,
        extra: { max: 10 },
      });
      await db.initialize();
      const runner = db.createQueryRunner();
      await base105.up(runner);
      await details161.up(runner);
      // 63HO6cBU (N1) — migratsiya 245 qo'shgan ustun (entity'da bor).
      await runner.query(
        'ALTER TABLE "finance_schema"."cashbox_cards" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamptz NULL',
      );
      await runner.release();

      cards = new CashboxCardService(
        db,
        activityLog as never,
        realtime as never,
      );
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
      );
      jest
        .spyOn(finance as any, 'scheduleMarketPaymentFollowUp')
        .mockResolvedValue(undefined);
      jest
        .spyOn(finance as any, 'tryPublishAdvanceNow')
        .mockResolvedValue(undefined);
    }, 60_000);

    afterAll(async () => {
      if (ORIGINAL_ENV === undefined) {
        delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
      } else {
        process.env.FINANCE_REQUIRE_OPEN_SHIFT = ORIGINAL_ENV;
      }
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    const cashboxRepo = () => db.getRepository(Cashbox);
    const cashboxOf = (userId: string, type: Cashbox_type) =>
      cashboxRepo().findOneByOrFail({ user_id: userId, cashbox_type: type });

    const seed = async () => {
      delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
      await db.query(
        `TRUNCATE TABLE "finance_schema"."cashbox_card_movements",
        "finance_schema"."cashbox_cards", "finance_schema"."cashbox_history",
        "finance_schema"."shifts", "finance_schema"."cashboxes"
        RESTART IDENTITY CASCADE`,
      );
      await cashboxRepo().save([
        cashboxRepo().create({
          user_id: '0',
          cashbox_type: Cashbox_type.MAIN,
          balance: 600_000,
          balance_cash: 500_000,
          balance_card: 100_000,
        }),
        cashboxRepo().create({
          user_id: BRANCH,
          cashbox_type: Cashbox_type.BRANCH,
          balance: 300_000,
          balance_cash: 250_000,
          balance_card: 50_000,
        }),
        cashboxRepo().create({
          user_id: OTHER_BRANCH,
          cashbox_type: Cashbox_type.BRANCH,
          balance: 10_000,
          balance_cash: 0,
          balance_card: 10_000,
        }),
        cashboxRepo().create({
          user_id: '501',
          cashbox_type: Cashbox_type.FOR_COURIER,
          balance: 200_000,
          balance_cash: 200_000,
          balance_card: 0,
        }),
      ]);
      activityLog.log.mockClear();
      realtime.cashboxCardChanged.mockClear();
    };

    /** Invariant SHU kassa uchun: Σ kartalar == balance_card; balance == naqd + karta. */
    const expectInvariant = async (branchId?: string) => {
      const list: any = await cards.listCards({
        include_inactive: true,
        ...(branchId ? { branch_id: branchId } : {}),
      });
      const cashbox = branchId
        ? await cashboxOf(branchId, Cashbox_type.BRANCH)
        : await cashboxOf('0', Cashbox_type.MAIN);
      const sum = list.data.cards.reduce(
        (s: number, c: { balance: number }) => s + c.balance,
        0,
      );
      expect(sum).toBeCloseTo(Number(cashbox.balance_card), 2);
      expect(list.data.total_card).toBeCloseTo(Number(cashbox.balance_card), 2);
      expect(Number(cashbox.balance)).toBeCloseTo(
        Number(cashbox.balance_cash) + Number(cashbox.balance_card),
        2,
      );
      return { list: list.data, cashbox };
    };
    const balances = (list: any) =>
      list.cards.map((c: any) => [c.name, c.balance, c.is_default]);

    const defaultIdOf = async (branchId?: string): Promise<string> => {
      const list: any = await cards.listCards(
        branchId ? { branch_id: branchId } : {},
      );
      return String(list.data.cards.find((c: any) => c.is_default).id);
    };

    /** 63HO6cBU — migratsiya 245 dan oldingi (eski) filial kartasi: nofaol. */
    const legacyBranchCard = async (
      name = 'Humo filial',
      branchId = BRANCH,
    ): Promise<string> => {
      const cashbox = await cashboxOf(branchId, Cashbox_type.BRANCH);
      const saved = await db.getRepository(CashboxCard).save(
        db.getRepository(CashboxCard).create({
          cashbox_id: String(cashbox.id),
          name,
          balance: 0,
          is_default: false,
          is_active: false,
        }),
      );
      return String(saved.id);
    };
    const disabled = {
      error: {
        statusCode: 400,
        message:
          "Filial kassasi naqd va kartaga ajratilmaydi — filialda karta amallari yo'q",
      },
    };

    it('migratsiya 161: mavjud MAIN kartalari O`ZGARMAYDI; ustunlar + CHECK; qayta up() xavfsiz; down() → up()', async () => {
      await seed();
      // Prod holati: 105 qo'llangan (161 dan OLDIN), MAIN kassada Asosiy +
      // nomli karta bor — 161 ularni o'zgartirmasligi shart.
      const pre = db.createQueryRunner();
      try {
        await details161.down(pre);
      } finally {
        await pre.release();
      }
      await db.query(
        `INSERT INTO "finance_schema"."cashbox_cards"
         ("cashbox_id", "name", "balance", "is_default", "is_active", "sort_order")
       VALUES (1, 'Asosiy karta', 0, true, true, 0),
              (1, 'Humo 8600', 40000, false, true, 2)`,
      );
      const snapshot = async () =>
        db.query(
          `SELECT "id", "cashbox_id", "name", "balance", "is_default", "is_active",
                "sort_order", "created_by", "is_deleted", "createdAt", "updatedAt"
           FROM "finance_schema"."cashbox_cards" ORDER BY "id"`,
        );
      const before = await snapshot();

      const runner = db.createQueryRunner();
      try {
        await details161.up(runner);
        await details161.up(runner); // guarded — ikkinchi marta ham xatosiz
      } finally {
        await runner.release();
      }
      expect(await snapshot()).toEqual(before);
      const added = await db.query(
        `SELECT "kind", "bank_name", "card_network", "last4", "holder_name", "note",
              "require_photo_on_shift_close", "ai_check_enabled"
         FROM "finance_schema"."cashbox_cards" ORDER BY "id"`,
      );
      expect(added).toEqual([
        {
          kind: null,
          bank_name: null,
          card_network: null,
          last4: null,
          holder_name: null,
          note: null,
          require_photo_on_shift_close: false,
          ai_check_enabled: false,
        },
        {
          kind: null,
          bank_name: null,
          card_network: null,
          last4: null,
          holder_name: null,
          note: null,
          require_photo_on_shift_close: false,
          ai_check_enabled: false,
        },
      ]);
      // Eski kartalar API'da ham avvalgidek (balans, Asosiy hosila).
      const list: any = await cards.listCards();
      expect(balances(list.data)).toEqual([
        ['Asosiy karta', 60_000, true],
        ['Humo 8600', 40_000, false],
      ]);

      // DB darajasidagi himoya: to'liq PAN / noma'lum tur / rasmsiz AI.
      await expect(
        db.query(
          `UPDATE "finance_schema"."cashbox_cards" SET "last4" = '8600123412341234' WHERE "id" = 2`,
        ),
      ).rejects.toThrow(/too long/);
      await expect(
        db.query(
          `UPDATE "finance_schema"."cashbox_cards" SET "last4" = '12a4' WHERE "id" = 2`,
        ),
      ).rejects.toThrow(/CHK_CASHBOX_CARD_LAST4/);
      await expect(
        db.query(
          `UPDATE "finance_schema"."cashbox_cards" SET "kind" = 'crypto' WHERE "id" = 2`,
        ),
      ).rejects.toThrow(/CHK_CASHBOX_CARD_KIND/);
      await expect(
        db.query(
          `UPDATE "finance_schema"."cashbox_cards" SET "ai_check_enabled" = true WHERE "id" = 2`,
        ),
      ).rejects.toThrow(/CHK_CASHBOX_CARD_AI_NEEDS_PHOTO/);

      const cols = async () =>
        (
          await db.query(
            `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'finance_schema' AND table_name = 'cashbox_cards'`,
          )
        ).map((r: { column_name: string }) => r.column_name);
      const runner2 = db.createQueryRunner();
      try {
        await details161.down(runner2);
        expect(await cols()).not.toEqual(
          expect.arrayContaining(['kind', 'last4', 'ai_check_enabled']),
        );
        expect(await cols()).toEqual(
          expect.arrayContaining(['name', 'balance', 'is_default']),
        );
      } finally {
        await details161.up(runner2);
        await runner2.release();
      }
      expect(await cols()).toEqual(
        expect.arrayContaining([
          'kind',
          'bank_name',
          'card_network',
          'last4',
          'holder_name',
          'note',
          'require_photo_on_shift_close',
          'ai_check_enabled',
        ]),
      );
    });

    it('⭐ 63HO6cBU: filial kassasida karta YO`Q — ro`yxat bo`sh (Asosiy karta yaratilmaydi), yaratish 400; MAIN bilan aralashmaydi', async () => {
      await seed();
      const list: any = await cards.listCards({ branch_id: BRANCH });
      expect(list.data).toMatchObject({
        cashbox_type: 'branch',
        branch_id: BRANCH,
        cards: [],
        balance_card: 0,
        total_card: 0,
        cards_disabled: true,
      });
      expect(await db.getRepository(CashboxCard).count()).toBe(0);
      await expect(
        cards.createCard({ name: 'Humo filial', branch_id: BRANCH }),
      ).rejects.toMatchObject(disabled);
      // Eski (nofaol) karta — faqat `include_inactive` bilan, balans 0.
      const legacy = await legacyBranchCard();
      const archived: any = await cards.listCards({
        branch_id: BRANCH,
        include_inactive: true,
      });
      expect(archived.data.cards).toEqual([
        expect.objectContaining({ id: legacy, balance: 0, is_active: false }),
      ]);
      // MAIN kassada filial kartasi yo'q, MAIN avvalgidek.
      const main: any = await cards.listCards();
      expect(main.data.cashbox_type).toBe('main');
      expect(main.data.cards.map((c: any) => c.name)).toEqual(['Asosiy karta']);
      await expect(
        cards.createCard({ name: 'Humo HQ' }),
      ).resolves.toMatchObject({ statusCode: 201 });
      // Filial kassasi yo'q — 404.
      await expect(
        cards.createCard({ name: 'X', branch_id: '999' }),
      ).rejects.toMatchObject({ error: { statusCode: 404 } });
    });

    it('last4 — faqat aniq 4 raqam (to`liq karta raqami 400); turi enum; matn uzunligi', async () => {
      await seed();
      for (const last4 of ['8600123412341234', '12345', '123', '12a4', 1234]) {
        await expect(
          cards.createCard({ name: `K ${String(last4)}`, last4 }),
        ).rejects.toMatchObject({
          error: { statusCode: 400, message: expect.stringMatching(/last4/) },
        });
      }
      await expect(
        cards.createCard({ name: 'K', kind: 'crypto' }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      await expect(
        cards.createCard({ name: 'K', holder_name: 'x'.repeat(151) }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      expect(
        await db.getRepository(CashboxCard).countBy({ is_default: false }),
      ).toBe(0);

      const ok: any = await cards.createCard({
        name: 'Hisob raqam',
        kind: 'bank_account',
        bank_name: 'Ipoteka bank',
        last4: '2205',
        holder_name: 'Nilufar Rashidova',
      });
      expect(ok.data.card).toMatchObject({
        kind: 'bank_account',
        last4: '2205',
      });
      // '' — tozalash.
      const cleared: any = await cards.updateCard({
        id: ok.data.card.id,
        last4: '',
      });
      expect(cleared.data.card.last4).toBeNull();
    });

    it('smena sozlamalari: ruxsatsiz (admin) 403; AI faqat rasm bilan (400); rasm o`chsa AI ham o`chadi', async () => {
      await seed();
      await expect(
        cards.createCard({ name: 'K', require_photo_on_shift_close: true }),
      ).rejects.toMatchObject({ error: { statusCode: 403 } });
      // BE-A: MAIN kartasida rasm sukut yoqiq — AI rasmsiz faqat rasm aniq
      // o'chirilganda (yoki filialda, bu yerda sukut o'chiq) 400.
      await expect(
        cards.createCard({
          name: 'K',
          require_photo_on_shift_close: false,
          ai_check_enabled: true,
          allow_shift_settings: true,
        }),
      ).rejects.toMatchObject({
        error: { statusCode: 400, message: expect.stringMatching(/AI/) },
      });
      await expect(
        cards.createCard({
          name: 'K',
          branch_id: BRANCH,
          ai_check_enabled: true,
          allow_shift_settings: true,
        }),
      ).rejects.toMatchObject({
        error: { statusCode: 400, message: expect.stringMatching(/AI/) },
      });
      const created: any = await cards.createCard({
        name: 'K',
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
        allow_shift_settings: true,
      });
      const id = created.data.card.id;
      expect(created.data.card).toMatchObject({
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
      });
      await expect(
        cards.updateCard({ id, ai_check_enabled: false }),
      ).rejects.toMatchObject({ error: { statusCode: 403 } });
      const off: any = await cards.updateCard({
        id,
        require_photo_on_shift_close: false,
        allow_shift_settings: true,
      });
      expect(off.data.card).toMatchObject({
        require_photo_on_shift_close: false,
        ai_check_enabled: false,
      });
    });

    it('BE-A: yangi karta sukuti — MAIN rasm + AI yoqiq (Asosiy karta ham), filialda karta yo`q (63HO6cBU); superadmin MAIN kartasini o`chiradi', async () => {
      await seed();
      // MAIN — bayroq berilmagan (admin ham yaratadi, 403 yo'q): true / true.
      const humo: any = await cards.createCard({
        name: 'Humo HQ',
        created_by: '2',
      });
      expect(humo.data.card).toMatchObject({
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
      });
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'finance.card_created',
          new_value: expect.objectContaining({
            require_photo_on_shift_close: true,
            ai_check_enabled: true,
          }),
        }),
      );
      // MAIN Asosiy kartasi (shu murojaatda yaratilgan) — ham yoqiq.
      const mainList: any = await cards.listCards();
      expect(mainList.data.cards).toHaveLength(2);
      for (const card of mainList.data.cards) {
        expect(card).toMatchObject({
          require_photo_on_shift_close: true,
          ai_check_enabled: true,
        });
      }
      // MAIN: superadmin faqat AI ni o'chirib yaratadi — rasm qoladi.
      const uz: any = await cards.createCard({
        name: 'Uzcard HQ',
        ai_check_enabled: false,
        allow_shift_settings: true,
      });
      expect(uz.data.card).toMatchObject({
        require_photo_on_shift_close: true,
        ai_check_enabled: false,
      });

      // 63HO6cBU — filialda karta yaratilmaydi (bayroqlar bilan ham).
      await expect(
        cards.createCard({
          name: 'Filial rasmli',
          branch_id: BRANCH,
          require_photo_on_shift_close: true,
          allow_shift_settings: true,
        }),
      ).rejects.toMatchObject(disabled);

      // PATCH: admin (ruxsatsiz) — 403; superadmin MAIN kartasini o'chiradi
      // (rasm o'chsa AI ham o'chadi), keyin qayta yoqadi.
      const id = String(humo.data.card.id);
      await expect(
        cards.updateCard({ id, require_photo_on_shift_close: false }),
      ).rejects.toMatchObject({ error: { statusCode: 403 } });
      const off: any = await cards.updateCard({
        id,
        require_photo_on_shift_close: false,
        allow_shift_settings: true,
      });
      expect(off.data.card).toMatchObject({
        require_photo_on_shift_close: false,
        ai_check_enabled: false,
      });
      await expect(
        cards.updateCard({
          id,
          ai_check_enabled: true,
          allow_shift_settings: true,
        }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      const on: any = await cards.updateCard({
        id,
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
        allow_shift_settings: true,
      });
      expect(on.data.card).toMatchObject({
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
      });
      const stored = await db.getRepository(CashboxCard).findOneByOrFail({
        id,
      });
      expect(stored.require_photo_on_shift_close).toBe(true);
      expect(stored.ai_check_enabled).toBe(true);
    });

    it('PATCH Asosiy kartada: yangi maydonlar tahrirlanadi, NOMI — 400; menejer doirasi — boshqa filial (eski) kartasi 403, o`z filiali tarixi o`qiladi', async () => {
      await seed();
      const def = await defaultIdOf();
      const res: any = await cards.updateCard({
        id: def,
        kind: 'plastic_card',
        bank_name: 'Agrobank',
        card_network: 'Uzcard',
        last4: '1234',
        holder_name: 'Shodiyor Ergashev',
      });
      expect(res.data.card).toMatchObject({
        is_default: true,
        name: 'Asosiy karta',
        bank_name: 'Agrobank',
        last4: '1234',
        balance: 100_000,
      });
      expect(activityLog.log).toHaveBeenLastCalledWith(
        expect.objectContaining({
          entity_type: 'CashboxCard',
          action: 'finance.card_updated',
        }),
      );
      await expect(
        cards.updateCard({ id: def, name: 'Boshqa nom' }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });

      // 63HO6cBU — eski filial kartasi: tarix (ko'chirma) saqlanadi.
      const legacy = await legacyBranchCard();
      await expect(
        cards.getLedger({ id: legacy, branch_id: OTHER_BRANCH }),
      ).rejects.toMatchObject({ error: { statusCode: 403 } });
      await expect(
        cards.listMovements({ card_id: legacy, branch_id: OTHER_BRANCH }),
      ).rejects.toMatchObject({ error: { statusCode: 403 } });
      // MAIN kartasi menejer doirasidan tashqarida.
      await expect(
        cards.getLedger({ id: def, branch_id: BRANCH }),
      ).rejects.toMatchObject({ error: { statusCode: 403 } });
      // O'z filiali — ruxsat (eski tarix o'qiladi).
      await expect(
        cards.getLedger({ id: legacy, branch_id: BRANCH }),
      ).resolves.toMatchObject({ statusCode: 200 });
      // Eski filial kartasini faollashtirish — 400.
      await expect(
        cards.setCardActive({ id: legacy, is_active: true, branch_id: BRANCH }),
      ).rejects.toMatchObject(disabled);
    });

    it('⭐ 63HO6cBU: filial operatsiyalari — filial `card_id` e`tiborsiz (jami), kuryerdan qabul va filial→HQ: MAIN oyog`i tanlangan HQ kartasiga', async () => {
      await seed();
      const legacy = await legacyBranchCard();
      const hq: any = await cards.createCard({ name: 'HQ Humo' });
      const hqId = String(hq.data.card.id);

      // Kuryerdan filialga (eski FE: click + filial kartasi) — jamiga.
      await finance.paymentsFromCourier({
        courier_id: '501',
        amount: 100_000,
        payment_method: PaymentMethod.CLICK,
        card_id: legacy,
        created_by: '25',
        dedup_epoch: 'gw:zv3-c1',
        receiver_user_id: BRANCH,
        receiver_cashbox_type: Cashbox_type.BRANCH,
      });
      let branch = await cashboxOf(BRANCH, Cashbox_type.BRANCH);
      expect(Number(branch.balance)).toBe(400_000);
      expect(Number(branch.balance_card)).toBe(0);
      expect(Number(branch.balance_cash)).toBe(400_000);

      // Filial → HQ «O'tkazma»: filial jamidan, HQ — tanlangan nomli karta.
      await finance.paymentFromBranchToMain({
        branch_id: BRANCH,
        amount: 350_000,
        payment_method: PaymentMethod.CLICK,
        card_id: hqId,
        branch_card_id: legacy,
        created_by: '1',
        dedup_epoch: 'gw:zv3-b1',
      });
      branch = await cashboxOf(BRANCH, Cashbox_type.BRANCH);
      expect(Number(branch.balance)).toBe(50_000);
      expect(Number(branch.balance_card)).toBe(0);
      const main = await cashboxOf('0', Cashbox_type.MAIN);
      expect(Number(main.balance_card)).toBe(450_000);
      expect(
        Number(
          (await db.getRepository(CashboxCard).findOneByOrFail({ id: hqId }))
            .balance,
        ),
      ).toBe(350_000);
      const legs = await db.getRepository(CashboxHistory).find({
        relations: ['cashbox'],
        order: { id: 'ASC' },
      });
      for (const leg of legs) {
        if (leg.cashbox.cashbox_type === Cashbox_type.BRANCH) {
          expect(leg.card_id).toBeNull();
        }
      }
      expect(
        legs.find(
          (leg) =>
            leg.cashbox.cashbox_type === Cashbox_type.MAIN &&
            leg.source_type === Source_type.BRANCH_TO_MAIN,
        )?.card_id,
      ).toBe(hqId);
      await expectInvariant();
    });

    it('⭐ N12 (MAIN) make-default: pul harakatlanmaydi, Σ == balance_card; eski Asosiy karta qoldig`i saqlanadi; ikkala ko`chirma to`g`ri; kartasiz to`lov — yangi Asosiyga; arxiv karta 400', async () => {
      await seed();
      const created: any = await cards.createCard({ name: 'Humo HQ' });
      const humo = String(created.data.card.id);
      const oldDef = await defaultIdOf();
      await cards.transfer({
        from_card_id: oldDef,
        to_card_id: humo,
        amount: 30_000,
        comment: 'x',
      });
      // Kartasiz CLICK chiqim — eski Asosiy kartadan.
      await finance.spendMoney({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        amount: 5_000,
        type: PaymentMethod.CLICK,
      });
      let state = await expectInvariant();
      expect(balances(state.list)).toEqual([
        ['Asosiy karta', 65_000, true],
        ['Humo HQ', 30_000, false],
      ]);

      const res: any = await cards.makeDefault({ id: humo, updated_by: '1' });
      expect(res.data).toMatchObject({
        changed: true,
        card: { id: humo, is_default: true, balance: 30_000 },
        previous_default: { id: oldDef, is_default: false, balance: 65_000 },
      });
      state = await expectInvariant();
      expect(Number(state.cashbox.balance_card)).toBe(95_000);
      expect(balances(state.list)).toEqual([
        ['Humo HQ', 30_000, true],
        ['Asosiy karta', 65_000, false],
      ]);
      // Eski Asosiy karta ko'chirmasi: kartasiz chiqim qatori unga yozildi.
      const oldLedger: any = await cards.getLedger({ id: oldDef });
      expect(oldLedger.data.summary).toMatchObject({
        opening_balance: 100_000,
        closing_balance: 65_000,
        current_balance: 65_000,
      });
      expect(oldLedger.data.items.map((r: any) => r.kind)).toEqual([
        'expense',
        'transfer_out',
      ]);
      const newLedger: any = await cards.getLedger({ id: humo });
      expect(newLedger.data.summary).toMatchObject({
        opening_balance: 0,
        current_balance: 30_000,
      });

      // Endi kartasiz CLICK kirim — yangi Asosiy (Humo) ga.
      await finance.fillTheCashbox({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        amount: 1_000,
        type: PaymentMethod.CLICK,
      });
      state = await expectInvariant();
      expect(balances(state.list)).toEqual([
        ['Humo HQ', 31_000, true],
        ['Asosiy karta', 65_000, false],
      ]);
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'finance.card_made_default' }),
      );
      // Takror — o'zgarish yo'q.
      const again: any = await cards.makeDefault({ id: humo });
      expect(again.data.changed).toBe(false);
      // Arxivlangan karta asosiy bo'lmaydi.
      const spare: any = await cards.createCard({ name: 'Zaxira' });
      await cards.setCardActive({ id: spare.data.card.id, is_active: false });
      await expect(
        cards.makeDefault({ id: spare.data.card.id }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      // Yaratishda «Asosiy karta qilish».
      const fresh: any = await cards.createCard({
        name: 'Visa yangi',
        make_default: true,
      });
      expect(fresh.data.card).toMatchObject({ is_default: true, balance: 0 });
      state = await expectInvariant();
      expect(balances(state.list)[0]).toEqual(['Visa yangi', 0, true]);
    });

    it('N7: arxiv filial «Asosiy karta»si (qoldiq 0) o`chadi (soft); qoldig`i bor bo`lsa va MAIN Asosiy kartasi — 400', async () => {
      await seed();
      const box = await cashboxOf(BRANCH, Cashbox_type.BRANCH);
      const saved = await db.getRepository(CashboxCard).save(
        db.getRepository(CashboxCard).create({
          cashbox_id: String(box.id),
          name: 'Asosiy karta',
          balance: 0,
          is_default: true,
          is_active: false,
        }),
      );
      // Migratsiyadan oldingi karta qismi (50 000) hali bor — 400.
      await expect(
        cards.deleteCard({ id: String(saved.id) }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      // Migratsiya 245 dan keyin: karta qismi jamiga o'tgan.
      await db.query(
        `UPDATE "finance_schema"."cashboxes"
            SET balance_cash = balance_cash + balance_card, balance_card = 0
          WHERE id = $1`,
        [box.id],
      );
      await cards.deleteCard({ id: String(saved.id) });
      const after = await db
        .getRepository(CashboxCard)
        .findOneByOrFail({ id: String(saved.id) });
      expect(after).toMatchObject({ isDeleted: true, is_active: false });
      expect(
        Number((await cashboxOf(BRANCH, Cashbox_type.BRANCH)).balance),
      ).toBe(300_000);
      // MAIN Asosiy kartasi — avvalgidek 400.
      const mainDefault = await defaultIdOf();
      await expect(cards.deleteCard({ id: mainDefault })).rejects.toMatchObject(
        { error: { statusCode: 400 } },
      );
    });

    it('63HO6cBU: eski filial kartasi — Asosiy qilish, o`tkazma 400; MAIN make-default avvalgidek', async () => {
      await seed();
      const legacy = await legacyBranchCard();
      const other = await legacyBranchCard('Uzcard filial');
      await expect(
        cards.makeDefault({ id: legacy, branch_id: BRANCH }),
      ).rejects.toMatchObject(disabled);
      await expect(
        cards.transfer({
          from_card_id: legacy,
          to_card_id: other,
          amount: 1,
          comment: 'x',
        }),
      ).rejects.toMatchObject(disabled);
      const hq: any = await cards.createCard({ name: 'HQ Humo' });
      await expect(
        cards.makeDefault({ id: String(hq.data.card.id) }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await expectInvariant();
    });

    it('63HO6cBU: filial kartasi konvertatsiyasi — 400 (smenadan qat`i nazar); filial smenasi bitta jami bilan yopiladi', async () => {
      await seed();
      const legacy = await legacyBranchCard();
      process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'all';
      jest
        .spyOn((finance as any).logger, 'warn')
        .mockImplementation(() => undefined);
      await finance.openShift({
        opened_by: '25',
        cashbox_user_id: BRANCH,
      });
      await expect(
        cards.convert({
          type: CardMovementType.CASH_TO_CARD,
          card_id: legacy,
          amount: 10_000,
          comment: 'kartaga',
        }),
      ).rejects.toMatchObject(disabled);
      const closed: any = await finance.closeShift({
        closed_by: '25',
        cashbox_user_id: BRANCH,
        closing_balance_cash: 300_000,
      });
      expect(closed.data).toMatchObject({
        expected_balance_cash: 300_000,
        expected_balance_card: 0,
        discrepancy_cash: 0,
        discrepancy_card: null,
      });
    });
  },
);
