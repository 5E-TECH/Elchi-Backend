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
});
