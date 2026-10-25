import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { FindOperator, QueryFailedError } from 'typeorm';
import { Commission_type, Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * i76gGjyq — market operatorlari (identity.market_operator.*).
 *
 * MUAMMO. Elchida market o'z operatorini yarata olmasdi (endpoint yo'q),
 * ro'yxat esa GET /users?role=operator orqali olinardi — market uchun 403,
 * market bo'yicha ko'lamlanmagan va rol nomi `operator` (biznes mantiq esa
 * `market_operator` ga tayanadi).
 *
 * Bu spec servis darajasini XOTIRADAGI repozitoriy bilan tekshiradi: ko'lam
 * (A marketi B ning operatorini ko'rmaydi/o'chirmaydi), rol va market_id
 * (TC4), parol hash, telefon unikalligi, komissiya chegaralari (TC5).
 */

type Row = Record<string, any>;

/** TypeORM `where` bandini qatorga solishtirish (tenglik + ILike). */
function matches(row: Row, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      if (expected.type !== 'ilike') {
        throw new Error(`unsupported operator ${expected.type}`);
      }
      const needle = String(expected.value).replace(/%/g, '').toLowerCase();
      return String(row[key] ?? '')
        .toLowerCase()
        .includes(needle);
    }
    const actual = row[key] ?? null;
    const want = expected ?? null;
    if (actual === null || want === null) {
      return actual === want;
    }
    return String(actual) === String(want as string | number | boolean);
  });
}

function makeRepo(seed: Row[]) {
  const rows: Row[] = seed.map((row) => ({ ...row }));
  let seq = 1000;
  const whereClauses = (where: unknown) =>
    (Array.isArray(where) ? where : [where]) as Record<string, unknown>[];
  return {
    rows,
    findOne: jest.fn(({ where }: { where: unknown }) => {
      const found = rows.find((row) =>
        whereClauses(where).some((clause) => matches(row, clause)),
      );
      return Promise.resolve(found ? { ...found } : null);
    }),
    findAndCount: jest.fn(
      ({
        where,
        skip = 0,
        take,
      }: {
        where: unknown;
        skip?: number;
        take?: number;
      }) => {
        const all = rows
          .filter((row) =>
            whereClauses(where).some((clause) => matches(row, clause)),
          )
          .sort((a, b) => Number(b.id) - Number(a.id));
        const page = all.slice(skip, take ? skip + take : undefined);
        return Promise.resolve([page.map((row) => ({ ...row })), all.length]);
      },
    ),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((entity: Row) => {
      if (!entity.id) {
        // DB unique(phone_number) ni taqlid qiladi.
        if (rows.some((row) => row.phone_number === entity.phone_number)) {
          return Promise.reject(
            new QueryFailedError(
              'INSERT',
              [],
              Object.assign(new Error('duplicate key'), { code: '23505' }),
            ),
          );
        }
        const now = new Date();
        const created = {
          ...entity,
          id: String(++seq),
          createdAt: now,
          updatedAt: now,
        };
        rows.push(created);
        return Promise.resolve({ ...created });
      }
      const index = rows.findIndex((row) => row.id === entity.id);
      rows[index] = { ...rows[index], ...entity, updatedAt: new Date() };
      return Promise.resolve({ ...rows[index] });
    }),
  };
}

const MARKET_A = '10';
const MARKET_B = '20';
const MARKET_BLOCKED = '30';

function seedRows(): Row[] {
  const base = { isDeleted: false, username: null, market_id: null };
  return [
    {
      ...base,
      id: MARKET_A,
      role: Roles.MARKET,
      status: Status.ACTIVE,
      name: 'A',
      phone_number: '+998900000010',
    },
    {
      ...base,
      id: MARKET_B,
      role: Roles.MARKET,
      status: Status.ACTIVE,
      name: 'B',
      phone_number: '+998900000020',
    },
    {
      ...base,
      id: MARKET_BLOCKED,
      role: Roles.MARKET,
      status: Status.INACTIVE,
      name: 'C',
      phone_number: '+998900000030',
    },
    {
      ...base,
      id: '40',
      role: Roles.CUSTOMER,
      status: Status.ACTIVE,
      name: 'Mijoz',
      phone_number: '+998901110000',
    },
    {
      ...base,
      id: '50',
      role: Roles.MARKET_OPERATOR,
      status: Status.ACTIVE,
      name: 'B operatori',
      phone_number: '+998905550050',
      market_id: MARKET_B,
      commission_type: null,
      commission_value: null,
    },
    // O'chirilgan A operatori — ro'yxatda chiqmasligi kerak.
    {
      ...base,
      id: '60',
      role: Roles.MARKET_OPERATOR,
      status: Status.INACTIVE,
      name: "A o'chirilgan",
      phone_number: '+998905550060-d1',
      market_id: MARKET_A,
      isDeleted: true,
    },
  ];
}

function makeService(seed: Row[] = seedRows()) {
  const repo = makeRepo(seed);
  const searchClient = { send: jest.fn(() => of({})), emit: jest.fn() };
  const financeClient = { send: jest.fn(() => of({})), emit: jest.fn() };
  const noopClient = { send: jest.fn(() => of({})), emit: jest.fn() };
  const bcrypt = {
    encrypt: jest.fn((plain: string) => Promise.resolve(`bcrypt$${plain}`)),
    compare: jest.fn(),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new UserServiceService(
    repo as any,
    searchClient as any, // search
    noopClient as any, // catalog
    noopClient as any, // order
    noopClient as any, // logistics
    financeClient as any, // finance
    noopClient as any, // branch
    bcrypt as any,
    { get: jest.fn() } as any,
    activityLog as any,
  );
  return { service, repo, bcrypt, activityLog, financeClient };
}

const marketReq = (id: string): RequesterContext => ({
  id,
  roles: [Roles.MARKET],
});

const dto = {
  name: '  Ali   Valiyev ',
  phone_number: '998901234567',
  password: 'secret123',
};

async function statusOf(
  promise: Promise<unknown>,
): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const payload = (error as RpcException)?.getError?.();
    return (payload as { statusCode?: number })?.statusCode;
  }
}

describe('UserServiceService — market operatorlari (i76gGjyq)', () => {
  describe('createMarketOperator', () => {
    it('TC4: rol market_operator, market_id = market, parol hash, telefon kanonik', async () => {
      const { service, repo, bcrypt, activityLog, financeClient } =
        makeService();

      const res: any = await service.createMarketOperator(
        MARKET_A,
        dto as never,
        marketReq(MARKET_A),
      );

      expect(res.statusCode).toBe(201);
      const stored = repo.rows.find((row) => row.id === res.data.id);
      expect(stored).toMatchObject({
        role: Roles.MARKET_OPERATOR,
        market_id: MARKET_A,
        status: Status.ACTIVE,
        name: 'Ali Valiyev',
        phone_number: '+998901234567',
        created_by: MARKET_A,
        isDeleted: false,
      });
      // Parol faqat hash holida saqlanadi va javobda umuman yo'q.
      expect(bcrypt.encrypt).toHaveBeenCalledWith('secret123');
      expect(stored?.password).toBe('bcrypt$secret123');
      expect(res.data).not.toHaveProperty('password');
      expect(res.data).not.toHaveProperty('refresh_token');
      expect(res.data).toMatchObject({
        role: 'market_operator',
        market_id: MARKET_A,
      });
      // Operatorga kassa YARATILMAYDI (pul ushlamaydi).
      expect(financeClient.send).not.toHaveBeenCalled();
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'User',
          action: 'created',
          user_id: MARKET_A,
          metadata: { market_id: MARKET_A },
        }),
      );
    });

    it("market_id kanonik: '010' ≡ '10' (market o'zi)", async () => {
      const { service, repo } = makeService();
      const res: any = await service.createMarketOperator(
        '010',
        dto as never,
        marketReq(MARKET_A),
      );
      expect(repo.rows.find((row) => row.id === res.data.id)?.market_id).toBe(
        MARKET_A,
      );
    });

    it('market boshqa market nomidan yarata olmaydi → 403, hech narsa yozilmaydi', async () => {
      const { service, repo } = makeService();
      expect(
        await statusOf(
          service.createMarketOperator(
            MARKET_B,
            dto as never,
            marketReq(MARKET_A),
          ),
        ),
      ).toBe(403);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it.each([
      [Roles.COURIER],
      [Roles.MARKET_OPERATOR],
      [Roles.MANAGER],
      [Roles.OPERATOR],
    ])('%s roli → 403', async (role) => {
      const { service, repo } = makeService();
      expect(
        await statusOf(
          service.createMarketOperator(MARKET_A, dto as never, {
            id: MARKET_A,
            roles: [role],
          }),
        ),
      ).toBe(403);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('bloklangan market → 403; mavjud bo`lmagan market → 404', async () => {
      const { service } = makeService();
      expect(
        await statusOf(
          service.createMarketOperator(
            MARKET_BLOCKED,
            dto as never,
            marketReq(MARKET_BLOCKED),
          ),
        ),
      ).toBe(403);
      expect(
        await statusOf(
          service.createMarketOperator('999', dto as never, marketReq('999')),
        ),
      ).toBe(404);
    });

    it('telefon unikal: band raqam (boshqa rol/format) → 409', async () => {
      const { service } = makeService();
      // Mijozda '+998901110000' bor — '998901110000' formatida ham ushlanadi.
      expect(
        await statusOf(
          service.createMarketOperator(
            MARKET_A,
            { ...dto, phone_number: '998901110000' } as never,
            marketReq(MARKET_A),
          ),
        ),
      ).toBe(409);
    });

    it('bir vaqtdagi takroriy yaratish (DB 23505) → 409, 500 emas', async () => {
      const { service } = makeService();
      Object.assign(service as any, {
        ensurePhoneUnique: jest.fn().mockResolvedValue(undefined),
      });
      await service.createMarketOperator(
        MARKET_A,
        dto as never,
        marketReq(MARKET_A),
      );
      expect(
        await statusOf(
          service.createMarketOperator(
            MARKET_A,
            dto as never,
            marketReq(MARKET_A),
          ),
        ),
      ).toBe(409);
    });

    it("noto'g'ri telefon/ism/parol/market_id → 400", async () => {
      const { service } = makeService();
      const req = marketReq(MARKET_A);
      expect(
        await statusOf(
          service.createMarketOperator(
            MARKET_A,
            { ...dto, phone_number: '12345' } as never,
            req,
          ),
        ),
      ).toBe(400);
      expect(
        await statusOf(
          service.createMarketOperator(
            MARKET_A,
            { ...dto, name: ' ' } as never,
            req,
          ),
        ),
      ).toBe(400);
      expect(
        await statusOf(
          service.createMarketOperator(
            MARKET_A,
            { ...dto, password: '12' } as never,
            req,
          ),
        ),
      ).toBe(400);
      expect(
        await statusOf(service.createMarketOperator('abc', dto as never, req)),
      ).toBe(400);
    });
  });

  describe('findMarketOperators — ko`lam (TC2)', () => {
    it("A faqat o'z operatorlarini ko'radi; B niki va o'chirilgani yo'q", async () => {
      const { service } = makeService();
      await service.createMarketOperator(
        MARKET_A,
        dto as never,
        marketReq(MARKET_A),
      );

      const res: any = await service.findMarketOperators(
        MARKET_A,
        { page: 1, limit: 100 },
        marketReq(MARKET_A),
      );

      expect(res.data.items).toHaveLength(1);
      expect(res.data.items[0]).toMatchObject({
        name: 'Ali Valiyev',
        role: Roles.MARKET_OPERATOR,
        market_id: MARKET_A,
      });
      expect(res.data.items.map((item: any) => item.id)).not.toContain('50');
      expect(res.data.items[0]).not.toHaveProperty('password');
      expect(res.data.meta).toMatchObject({ page: 1, limit: 100, total: 1 });
    });

    it('market B ning ro`yxatini A so`rasa → 403', async () => {
      const { service } = makeService();
      expect(
        await statusOf(
          service.findMarketOperators(MARKET_B, {}, marketReq(MARKET_A)),
        ),
      ).toBe(403);
    });

    it('superadmin/admin ham → 403 (ko`lam faqat market: requester.sub = market_id)', async () => {
      const { service } = makeService();
      for (const role of [Roles.ADMIN, Roles.SUPERADMIN]) {
        expect(
          await statusOf(
            service.findMarketOperators(
              MARKET_B,
              {},
              { id: '1', roles: [role] },
            ),
          ),
        ).toBe(403);
      }
    });

    it("qidiruv (ism/telefon) va status filtri ko'lam ichida", async () => {
      const { service } = makeService();
      const req = marketReq(MARKET_A);
      await service.createMarketOperator(MARKET_A, dto as never, req);
      await service.createMarketOperator(
        MARKET_A,
        { ...dto, name: 'Vali', phone_number: '+998907777777' } as never,
        req,
      );

      const byName: any = await service.findMarketOperators(
        MARKET_A,
        { search: 'ali v' },
        req,
      );
      expect(byName.data.items.map((item: any) => item.name)).toEqual([
        'Ali Valiyev',
      ]);
      const byPhone: any = await service.findMarketOperators(
        MARKET_A,
        { search: '7777' },
        req,
      );
      expect(byPhone.data.items.map((item: any) => item.name)).toEqual([
        'Vali',
      ]);
      // B operatori ('B operatori') A qidiruvida chiqmaydi.
      const foreign: any = await service.findMarketOperators(
        MARKET_A,
        { search: 'operatori' },
        req,
      );
      expect(foreign.data.items).toHaveLength(0);

      expect(
        await statusOf(
          service.findMarketOperators(MARKET_A, { status: 'bogus' }, req),
        ),
      ).toBe(400);
    });
  });

  describe('deleteMarketOperator (TC5)', () => {
    it("o'z operatori soft-delete: telefon bo'shaydi, sessiya yopiladi, log", async () => {
      const { service, repo, activityLog } = makeService();
      const req = marketReq(MARKET_A);
      const created: any = await service.createMarketOperator(
        MARKET_A,
        dto as never,
        req,
      );
      repo.rows.find((row) => row.id === created.data.id)!.refresh_token =
        'hash';

      const res: any = await service.deleteMarketOperator(
        created.data.id,
        MARKET_A,
        req,
      );

      expect(res).toMatchObject({
        statusCode: 200,
        data: { id: created.data.id },
      });
      const stored = repo.rows.find((row) => row.id === created.data.id)!;
      expect(stored).toMatchObject({
        isDeleted: true,
        status: Status.INACTIVE,
        refresh_token: null,
      });
      expect(stored.phone_number).not.toBe('+998901234567');
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deleted',
          entity_id: created.data.id,
        }),
      );
      const list: any = await service.findMarketOperators(MARKET_A, {}, req);
      expect(list.data.items).toHaveLength(0);
      // Raqam yana bo'sh — qayta yaratish mumkin.
      const again: any = await service.createMarketOperator(
        MARKET_A,
        dto as never,
        req,
      );
      expect(again.statusCode).toBe(201);
    });

    it("A B ning operatorini o'chira olmaydi → 404, qator o'zgarmaydi (TC2)", async () => {
      const { service, repo } = makeService();
      expect(
        await statusOf(
          service.deleteMarketOperator('50', MARKET_A, marketReq(MARKET_A)),
        ),
      ).toBe(404);
      expect(repo.rows.find((row) => row.id === '50')).toMatchObject({
        isDeleted: false,
        status: Status.ACTIVE,
      });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('market_operator bo`lmagan qator (market, mijoz) va noto`g`ri id → 404', async () => {
      const { service } = makeService();
      const req = marketReq(MARKET_A);
      expect(
        await statusOf(service.deleteMarketOperator(MARKET_A, MARKET_A, req)),
      ).toBe(404);
      expect(
        await statusOf(service.deleteMarketOperator('40', MARKET_A, req)),
      ).toBe(404);
      expect(
        await statusOf(service.deleteMarketOperator('abc', MARKET_A, req)),
      ).toBe(404);
      // Allaqachon o'chirilgan — 404.
      expect(
        await statusOf(service.deleteMarketOperator('60', MARKET_A, req)),
      ).toBe(404);
    });
  });

  describe('updateMarketOperatorCommission (TC5)', () => {
    async function withOperator() {
      const ctx = makeService();
      const created: any = await ctx.service.createMarketOperator(
        MARKET_A,
        dto as never,
        marketReq(MARKET_A),
      );
      return { ...ctx, operatorId: created.data.id as string };
    }

    it('percent va fixed saqlanadi, ro`yxatda ko`rinadi, log yoziladi', async () => {
      const { service, repo, activityLog, operatorId } = await withOperator();
      const req = marketReq(MARKET_A);

      const percent: any = await service.updateMarketOperatorCommission(
        operatorId,
        MARKET_A,
        { commission_type: Commission_type.PERCENT, commission_value: 7.5 },
        req,
      );
      expect(percent.data).toMatchObject({
        commission_type: 'percent',
        commission_value: 7.5,
      });
      expect(activityLog.logChange).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: operatorId,
          old_value: { commission_type: null, commission_value: null },
          new_value: { commission_type: 'percent', commission_value: 7.5 },
          metadata: {
            market_id: MARKET_A,
            reason: 'market_operator_commission',
          },
        }),
      );

      const fixed: any = await service.updateMarketOperatorCommission(
        operatorId,
        MARKET_A,
        { commission_type: Commission_type.FIXED, commission_value: 15000 },
        req,
      );
      expect(fixed.data).toMatchObject({
        commission_type: 'fixed',
        commission_value: 15000,
      });
      expect(repo.rows.find((row) => row.id === operatorId)).toMatchObject({
        commission_type: 'fixed',
        commission_value: 15000,
      });

      const list: any = await service.findMarketOperators(MARKET_A, {}, req);
      expect(list.data.items[0]).toMatchObject({
        commission_type: 'fixed',
        commission_value: 15000,
      });
    });

    it('null — tozalash; faqat bitta maydon — qolgani saqlanadi', async () => {
      const { service, operatorId } = await withOperator();
      const req = marketReq(MARKET_A);
      await service.updateMarketOperatorCommission(
        operatorId,
        MARKET_A,
        { commission_type: Commission_type.FIXED, commission_value: 5000 },
        req,
      );
      const onlyValue: any = await service.updateMarketOperatorCommission(
        operatorId,
        MARKET_A,
        { commission_value: 6000 },
        req,
      );
      expect(onlyValue.data).toMatchObject({
        commission_type: 'fixed',
        commission_value: 6000,
      });
      const cleared: any = await service.updateMarketOperatorCommission(
        operatorId,
        MARKET_A,
        { commission_type: null, commission_value: null },
        req,
      );
      expect(cleared.data).toMatchObject({
        commission_type: null,
        commission_value: null,
      });
    });

    it('chegaralar: percent > 100, fixed > 1 000 000, manfiy, 3 kasr, bo`sh tana → 400', async () => {
      const { service, repo, operatorId } = await withOperator();
      const req = marketReq(MARKET_A);
      const cases: Array<Record<string, unknown>> = [
        { commission_type: 'percent', commission_value: 100.01 },
        { commission_type: 'fixed', commission_value: 1_000_001 },
        { commission_type: 'percent', commission_value: -1 },
        { commission_type: 'percent', commission_value: 1.005 },
        { commission_type: 'bonus', commission_value: 1 },
        {},
      ];
      for (const body of cases) {
        expect(
          await statusOf(
            service.updateMarketOperatorCommission(
              operatorId,
              MARKET_A,
              body as never,
              req,
            ),
          ),
        ).toBe(400);
      }
      // Chegaradagi qiymatlar o'tadi.
      await service.updateMarketOperatorCommission(
        operatorId,
        MARKET_A,
        { commission_type: Commission_type.PERCENT, commission_value: 100 },
        req,
      );
      expect(
        repo.rows.find((row) => row.id === operatorId)?.commission_value,
      ).toBe(100);
    });

    it('faqat turni almashtirish ham BIRLASHGAN holat bo`yicha tekshiriladi (fixed 50 000 → percent = 400)', async () => {
      const { service, repo, operatorId } = await withOperator();
      const req = marketReq(MARKET_A);
      await service.updateMarketOperatorCommission(
        operatorId,
        MARKET_A,
        { commission_type: Commission_type.FIXED, commission_value: 50000 },
        req,
      );
      expect(
        await statusOf(
          service.updateMarketOperatorCommission(
            operatorId,
            MARKET_A,
            { commission_type: Commission_type.PERCENT },
            req,
          ),
        ),
      ).toBe(400);
      expect(repo.rows.find((row) => row.id === operatorId)).toMatchObject({
        commission_type: 'fixed',
        commission_value: 50000,
      });
    });

    it('B marketi A operatorining komissiyasini o`zgartira olmaydi → 404 (TC2)', async () => {
      const { service, repo, operatorId } = await withOperator();
      expect(
        await statusOf(
          service.updateMarketOperatorCommission(
            operatorId,
            MARKET_B,
            { commission_type: Commission_type.PERCENT, commission_value: 50 },
            marketReq(MARKET_B),
          ),
        ),
      ).toBe(404);
      expect(
        repo.rows.find((row) => row.id === operatorId)?.commission_type,
      ).toBeNull();
    });
  });

  describe('setMarketOperatorStatus (mFkrqvMi)', () => {
    async function withOperator() {
      const ctx = makeService();
      const created: any = await ctx.service.createMarketOperator(
        MARKET_A,
        dto as never,
        marketReq(MARKET_A),
      );
      const operatorId = created.data.id as string;
      const row = ctx.repo.rows.find((r) => r.id === operatorId)!;
      // Faol sessiya + komissiya + avvalgi epoch (holat o'zgarishi
      // ularga tegmasligi / sessiyani yopishi tekshiriladi).
      row.refresh_token = 'hash';
      row.session_epoch = 3;
      row.commission_type = Commission_type.PERCENT;
      row.commission_value = 5;
      ctx.activityLog.log.mockClear();
      ctx.repo.save.mockClear();
      return { ...ctx, operatorId };
    }

    it('⭐ o`z operatori → inactive: sessiyalar yopiladi, komissiya saqlanadi, STATUS_CHANGE (muallif — market)', async () => {
      const { service, repo, activityLog, operatorId } = await withOperator();

      const res: any = await service.setMarketOperatorStatus(
        operatorId,
        MARKET_A,
        { status: 'inactive' },
        marketReq(MARKET_A),
      );

      expect(res.statusCode).toBe(200);
      expect(res.data).toMatchObject({
        id: operatorId,
        status: Status.INACTIVE,
        commission_type: 'percent',
        commission_value: 5,
      });
      expect(res.data).not.toHaveProperty('refresh_token');
      const stored = repo.rows.find((row) => row.id === operatorId)!;
      expect(stored).toMatchObject({
        status: Status.INACTIVE,
        refresh_token: null,
        session_epoch: 4,
        isDeleted: false,
        market_id: MARKET_A,
        commission_type: 'percent',
        commission_value: 5,
      });
      expect(activityLog.log).toHaveBeenCalledTimes(1);
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'User',
          entity_id: operatorId,
          action: 'status_change',
          old_value: { status: 'active' },
          new_value: { status: 'inactive' },
          user_id: MARKET_A,
          user_role: Roles.MARKET,
          metadata: {
            market_id: MARKET_A,
            reason: 'market_operator_status',
          },
          description: `Operator #${operatorId} nofaol qilindi`,
        }),
      );

      // GET ro'yxatida holat ko'rinadi va `status` filtri ishlaydi.
      const list: any = await service.findMarketOperators(
        MARKET_A,
        { status: 'inactive' },
        marketReq(MARKET_A),
      );
      expect(list.data.items).toEqual([
        expect.objectContaining({ id: operatorId, status: 'inactive' }),
      ]);
      const active: any = await service.findMarketOperators(
        MARKET_A,
        { status: 'active' },
        marketReq(MARKET_A),
      );
      expect(active.data.items).toEqual([]);
    });

    it('⭐ qayta faollashtirish → active; epoch o`zgarmaydi, log yoziladi', async () => {
      const { service, repo, activityLog, operatorId } = await withOperator();
      const req = marketReq(MARKET_A);
      await service.setMarketOperatorStatus(
        operatorId,
        MARKET_A,
        { status: 'inactive' },
        req,
      );
      activityLog.log.mockClear();

      const res: any = await service.setMarketOperatorStatus(
        operatorId,
        MARKET_A,
        { status: 'active' },
        req,
      );
      expect(res.data.status).toBe('active');
      expect(repo.rows.find((row) => row.id === operatorId)).toMatchObject({
        status: Status.ACTIVE,
        session_epoch: 4,
      });
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'status_change',
          old_value: { status: 'inactive' },
          new_value: { status: 'active' },
          description: `Operator #${operatorId} qayta faollashtirildi`,
        }),
      );
    });

    it('holat o`zgarmasa — 200, saqlanmaydi, jurnal yo`q, sessiya tegilmaydi', async () => {
      const { service, repo, activityLog, operatorId } = await withOperator();
      const res: any = await service.setMarketOperatorStatus(
        operatorId,
        MARKET_A,
        { status: 'active' },
        marketReq(MARKET_A),
      );
      expect(res.statusCode).toBe(200);
      expect(repo.save).not.toHaveBeenCalled();
      expect(activityLog.log).not.toHaveBeenCalled();
      expect(repo.rows.find((row) => row.id === operatorId)).toMatchObject({
        refresh_token: 'hash',
        session_epoch: 3,
      });
    });

    it('⭐ A B ning operatorini nofaol qila olmaydi → 404, qator o`zgarmaydi', async () => {
      const { service, repo } = makeService();
      expect(
        await statusOf(
          service.setMarketOperatorStatus(
            '50',
            MARKET_A,
            { status: 'inactive' },
            marketReq(MARKET_A),
          ),
        ),
      ).toBe(404);
      expect(repo.rows.find((row) => row.id === '50')).toMatchObject({
        status: Status.ACTIVE,
      });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('A B nomidan (market_id = B) so`rasa → 403', async () => {
      const { service, repo } = makeService();
      expect(
        await statusOf(
          service.setMarketOperatorStatus(
            '50',
            MARKET_B,
            { status: 'inactive' },
            marketReq(MARKET_A),
          ),
        ),
      ).toBe(403);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('o`chirilgan operator, operator bo`lmagan qator, noto`g`ri id → 404', async () => {
      const { service, repo } = makeService();
      const req = marketReq(MARKET_A);
      for (const id of ['60', MARKET_A, '40', 'abc']) {
        expect(
          await statusOf(
            service.setMarketOperatorStatus(
              id,
              MARKET_A,
              { status: 'inactive' },
              req,
            ),
          ),
        ).toBe(404);
      }
      expect(repo.save).not.toHaveBeenCalled();
    });

    it.each([['blocked'], [''], [undefined], [null], [1], [true]])(
      'status = %p → 400',
      async (status) => {
        const { service, repo, operatorId } = await withOperator();
        expect(
          await statusOf(
            service.setMarketOperatorStatus(
              operatorId,
              MARKET_A,
              { status },
              marketReq(MARKET_A),
            ),
          ),
        ).toBe(400);
        expect(repo.save).not.toHaveBeenCalled();
      },
    );

    it.each([
      [Roles.SUPERADMIN],
      [Roles.ADMIN],
      [Roles.MARKET_OPERATOR],
      [Roles.COURIER],
      [Roles.MANAGER],
    ])('%s roli → 403 (faqat market)', async (role) => {
      const { service, repo, operatorId } = await withOperator();
      expect(
        await statusOf(
          service.setMarketOperatorStatus(
            operatorId,
            MARKET_A,
            { status: 'inactive' },
            { id: MARKET_A, roles: [role] },
          ),
        ),
      ).toBe(403);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('bloklangan market operatorini faollashtira olmaydi → 403 (nofaol qilish mumkin)', async () => {
      const { service, repo } = makeService();
      repo.rows.push(
        {
          id: '70',
          role: Roles.MARKET_OPERATOR,
          status: Status.INACTIVE,
          name: 'C operatori',
          phone_number: '+998905550070',
          market_id: MARKET_BLOCKED,
          isDeleted: false,
          username: null,
        },
        {
          id: '71',
          role: Roles.MARKET_OPERATOR,
          status: Status.ACTIVE,
          name: 'C operatori 2',
          phone_number: '+998905550071',
          market_id: MARKET_BLOCKED,
          isDeleted: false,
          username: null,
          refresh_token: 'hash',
          session_epoch: 0,
        },
      );
      const req = marketReq(MARKET_BLOCKED);
      expect(
        await statusOf(
          service.setMarketOperatorStatus(
            '70',
            MARKET_BLOCKED,
            { status: 'active' },
            req,
          ),
        ),
      ).toBe(403);
      expect(repo.rows.find((row) => row.id === '70')?.status).toBe(
        Status.INACTIVE,
      );
      const res: any = await service.setMarketOperatorStatus(
        '71',
        MARKET_BLOCKED,
        { status: 'inactive' },
        req,
      );
      expect(res.data.status).toBe('inactive');
      expect(repo.rows.find((row) => row.id === '71')).toMatchObject({
        refresh_token: null,
        session_epoch: 1,
      });
    });
  });

  describe('createMarketOperator — ixtiyoriy komissiya (B3ZtzCCx)', () => {
    // Seed'dagi o'chirilgan '60' hisobga kirmaydi — faqat tirik operatorlar.
    const operatorsOf = (repo: ReturnType<typeof makeService>['repo']) =>
      repo.rows.filter(
        (row) =>
          row.role === Roles.MARKET_OPERATOR &&
          row.market_id === MARKET_A &&
          !row.isDeleted,
      );

    it.each([
      [Commission_type.PERCENT, 7.5],
      [Commission_type.PERCENT, 100],
      [Commission_type.PERCENT, 0],
      [Commission_type.FIXED, 50000],
      [Commission_type.FIXED, 1_000_000],
    ])(
      '⭐ %s %p — BITTA save bilan operator + komissiya, javob va jurnalda ko`rinadi',
      async (type, value) => {
        const { service, repo, activityLog } = makeService();
        const res: any = await service.createMarketOperator(
          MARKET_A,
          { ...dto, commission_type: type, commission_value: value } as never,
          marketReq(MARKET_A),
        );
        expect(res.statusCode).toBe(201);
        expect(res.data).toMatchObject({
          commission_type: type,
          commission_value: value,
        });
        // Atomik: alohida PATCH yo'q — yagona INSERT komissiya bilan.
        expect(repo.save).toHaveBeenCalledTimes(1);
        expect(repo.save.mock.calls[0][0]).toMatchObject({
          commission_type: type,
          commission_value: value,
        });
        expect(repo.rows.find((row) => row.id === res.data.id)).toMatchObject({
          commission_type: type,
          commission_value: value,
        });
        expect(activityLog.log).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'created',
            entity_id: res.data.id,
            new_value: expect.objectContaining({
              commission_type: type,
              commission_value: value,
            }),
          }),
        );
        // Ro'yxatda (GET market-operators) ham ko'rinadi.
        const list: any = await service.findMarketOperators(
          MARKET_A,
          {},
          marketReq(MARKET_A),
        );
        expect(list.data.items[0]).toMatchObject({
          id: res.data.id,
          commission_type: type,
          commission_value: value,
        });
      },
    );

    it.each([
      ['berilmagan', {}],
      ['ikkalasi null', { commission_type: null, commission_value: null }],
    ])('komissiya %s — avvalgidek komissiyasiz (null)', async (_l, extra) => {
      const { service, repo, activityLog } = makeService();
      const res: any = await service.createMarketOperator(
        MARKET_A,
        { ...dto, ...extra } as never,
        marketReq(MARKET_A),
      );
      expect(res.statusCode).toBe(201);
      expect(repo.rows.find((row) => row.id === res.data.id)).toMatchObject({
        commission_type: null,
        commission_value: null,
      });
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          new_value: expect.objectContaining({
            commission_type: null,
            commission_value: null,
          }),
        }),
      );
    });

    it.each([
      ['faqat turi', { commission_type: Commission_type.PERCENT }],
      ['faqat qiymati', { commission_value: 5 }],
      [
        'turi null, qiymati bor',
        { commission_type: null, commission_value: 5 },
      ],
      [
        'turi bor, qiymati null',
        { commission_type: Commission_type.FIXED, commission_value: null },
      ],
      [
        'percent > 100',
        { commission_type: Commission_type.PERCENT, commission_value: 100.01 },
      ],
      [
        'fixed > 1 000 000',
        { commission_type: Commission_type.FIXED, commission_value: 1_000_001 },
      ],
      [
        'manfiy',
        { commission_type: Commission_type.FIXED, commission_value: -1 },
      ],
      [
        '3 kasr',
        { commission_type: Commission_type.PERCENT, commission_value: 1.005 },
      ],
      ['noma`lum tur', { commission_type: 'bonus', commission_value: 5 }],
      [
        'qiymat satr',
        { commission_type: Commission_type.PERCENT, commission_value: '5' },
      ],
      [
        'NaN',
        { commission_type: Commission_type.PERCENT, commission_value: NaN },
      ],
    ])(
      '⭐ %s → 400, operator YARATILMAYDI (hech narsa yozilmaydi)',
      async (_label, extra) => {
        const { service, repo, activityLog } = makeService();
        expect(
          await statusOf(
            service.createMarketOperator(
              MARKET_A,
              { ...dto, ...extra } as never,
              marketReq(MARKET_A),
            ),
          ),
        ).toBe(400);
        expect(repo.save).not.toHaveBeenCalled();
        expect(activityLog.log).not.toHaveBeenCalled();
        expect(operatorsOf(repo)).toHaveLength(0);
      },
    );

    it('PATCH :id/commission bilan AYNI chegara xabarlari', async () => {
      const { service } = makeService();
      const req = marketReq(MARKET_A);
      const messageOf = async (promise: Promise<unknown>) => {
        try {
          await promise;
          return undefined;
        } catch (error) {
          return ((error as RpcException).getError() as { message?: string })
            .message;
        }
      };
      const created: any = await service.createMarketOperator(
        MARKET_A,
        { ...dto, phone_number: '998901230000' } as never,
        req,
      );
      for (const body of [
        { commission_type: Commission_type.PERCENT, commission_value: 150 },
        { commission_type: Commission_type.FIXED, commission_value: 2_000_000 },
        { commission_type: Commission_type.FIXED, commission_value: -5 },
        { commission_type: Commission_type.PERCENT, commission_value: 1.005 },
      ]) {
        const onCreate = await messageOf(
          service.createMarketOperator(
            MARKET_A,
            { ...dto, ...body } as never,
            req,
          ),
        );
        const onPatch = await messageOf(
          service.updateMarketOperatorCommission(
            created.data.id,
            MARKET_A,
            body as never,
            req,
          ),
        );
        expect(onCreate).toBeDefined();
        expect(onCreate).toBe(onPatch);
      }
    });
  });
});
