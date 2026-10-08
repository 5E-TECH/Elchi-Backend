import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NEVER, TimeoutError, of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';
import { CreateManagerRequestDto } from './dto/identity.swagger.dto';

describe('ApiGatewayController', () => {
  let apiGatewayController: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let financeClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };

  beforeEach(async () => {
    identityClient = {
      send: jest.fn().mockReturnValue(of({ ok: true })),
    };
    financeClient = {
      send: jest.fn().mockReturnValue(of({ ok: true })),
    };
    branchClient = {
      send: jest.fn().mockReturnValue(of({ ok: true })),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        {
          provide: 'IDENTITY',
          useValue: identityClient,
        },
        {
          provide: 'FINANCE',
          useValue: financeClient,
        },
        {
          provide: 'BRANCH',
          useValue: branchClient,
        },
      ],
    }).compile();

    apiGatewayController = app.get<ApiGatewayController>(ApiGatewayController);
  });

  it('should define controller', () => {
    expect(apiGatewayController).toBeDefined();
  });

  it('returns branch managers enriched with branch and branch cashbox info', async () => {
    identityClient.send.mockReturnValueOnce(
      of({
        data: {
          items: [{ id: '9', name: 'Asosiy filial manager', role: 'manager' }],
          meta: { total: 1, page: 1, limit: 10000, totalPages: 1 },
        },
      }),
    );
    branchClient.send.mockReturnValueOnce(
      of({
        data: {
          items: [
            {
              id: '16',
              name: 'Asosiy filial',
              manager_id: '9',
              olinishi_kerak: 99999999,
              berilishi_kerak: 24830000,
            },
          ],
        },
      }),
    );
    financeClient.send.mockReturnValueOnce(
      of({
        data: {
          id: 'cashbox-16',
          user_id: '16',
          cashbox_type: 'branch',
          balance: 0,
        },
      }),
    );

    const response = await apiGatewayController.getManagers(
      undefined,
      'active',
      undefined,
      '10000',
      { user: { sub: '1', username: 'admin', roles: ['admin'] } },
    );

    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_all' },
      expect.objectContaining({
        query: expect.objectContaining({ role: 'manager', status: 'active' }),
      }),
    );
    expect(response.data.items).toEqual([
      expect.objectContaining({
        id: '9',
        role: 'manager',
        branch_id: '16',
        payable_to_hq: 24830000,
        berilishi_kerak: 24830000,
        olinishi_kerak: 24830000,
        branch: expect.objectContaining({ name: 'Asosiy filial' }),
        cashbox: expect.objectContaining({ user_id: '16' }),
      }),
    ]);
  });

  /**
   * C7 — GET /couriers filial so'rovchisi uchun: filial kuryerlari AVVAL
   * branch_users'dan olinadi, identity esa `user_ids` bilan sahifalanadi.
   * Ilgari identity avval sahifalardi (≤ 100), filial filtri keyin — HQ
   * kuryerlari 100 talik sahifadan tushib qolardi.
   */
  describe('getCouriers — filial bo‘yicha oldindan filtrlash', () => {
    const registratorReq = {
      user: { sub: '269', username: 'hq-reg', roles: ['registrator'] },
    };

    const mockBranchUsers = (rows: Array<Record<string, unknown>>) =>
      branchClient.send.mockImplementation(({ cmd }: { cmd: string }) => {
        if (cmd === 'branch.user.find_by_user') {
          return of({ data: { branch_id: '1', role: 'REGISTRATOR' } });
        }
        if (cmd === 'branch.user.find_by_branch') {
          return of({ data: rows });
        }
        return of({ data: null });
      });

    const cmdCallOrder = (client: { send: jest.Mock }, cmd: string) => {
      const index = client.send.mock.calls.findIndex(
        ([pattern]: [{ cmd: string }]) => pattern.cmd === cmd,
      );
      return index === -1
        ? undefined
        : client.send.mock.invocationCallOrder[index];
    };

    it("registrator: branch_users identity'dan OLDIN so'raladi, identity'ga faqat COURIER user_ids ketadi", async () => {
      mockBranchUsers([
        { user_id: '263', role: 'COURIER' },
        { user_id: '269', role: 'REGISTRATOR' },
        { user_id: '300', role: 'courier' },
      ]);
      identityClient.send.mockReturnValue(
        of({
          statusCode: 200,
          message: 'success',
          data: {
            items: [
              { id: '263', name: 'HQ kuryer 1' },
              { id: '300', name: 'HQ kuryer 2' },
            ],
            meta: { page: 1, limit: 100, total: 2, totalPages: 1 },
          },
        }),
      );
      financeClient.send.mockReturnValue(
        of({ data: { cashbox_type: 'couriers', balance: 0 } }),
      );

      const response = await apiGatewayController.getCouriers(
        undefined,
        'active',
        undefined,
        undefined,
        undefined,
        '1',
        '100',
        registratorReq,
      );

      const findByUserOrder = cmdCallOrder(
        branchClient,
        'branch.user.find_by_user',
      );
      const findByBranchOrder = cmdCallOrder(
        branchClient,
        'branch.user.find_by_branch',
      );
      const identityOrder = identityClient.send.mock.invocationCallOrder[0];
      expect(findByUserOrder).toBeLessThan(findByBranchOrder as number);
      expect(findByBranchOrder).toBeLessThan(identityOrder);

      expect(identityClient.send).toHaveBeenCalledTimes(1);
      expect(identityClient.send).toHaveBeenCalledWith(
        { cmd: 'identity.courier.find_all' },
        {
          query: expect.objectContaining({
            status: 'active',
            page: 1,
            limit: 100,
            user_ids: ['263', '300'],
          }),
        },
      );
      expect(branchClient.send).toHaveBeenCalledWith(
        { cmd: 'branch.user.find_by_branch' },
        expect.objectContaining({ branch_id: '1' }),
      );
      // Ikkinchi find_by_branch chaqiruvi yo'q (oldindan olingan ro'yxat ishlatiladi).
      expect(
        branchClient.send.mock.calls.filter(
          ([pattern]: [{ cmd: string }]) =>
            pattern.cmd === 'branch.user.find_by_branch',
        ),
      ).toHaveLength(1);
      expect(response.data.items.map((c: { id: string }) => c.id)).toEqual([
        '263',
        '300',
      ]);
      expect(response.data.meta.total).toBe(2);
    });

    it("kuryeri yo'q filial: bo'sh sahifa, identity va finance chaqirilmaydi", async () => {
      mockBranchUsers([{ user_id: '269', role: 'REGISTRATOR' }]);

      const response = await apiGatewayController.getCouriers(
        undefined,
        'active',
        undefined,
        undefined,
        undefined,
        '2',
        '50',
        registratorReq,
      );

      expect(response).toEqual({
        statusCode: 200,
        message: 'success',
        data: {
          items: [],
          meta: { page: 2, limit: 50, total: 0, totalPages: 1 },
        },
      });
      expect(identityClient.send).not.toHaveBeenCalled();
      expect(financeClient.send).not.toHaveBeenCalled();
    });

    it("bo'sh sahifa meta'si identity'dagi kabi normallashtiriladi (sukut: page 1, limit 10; limit ≤ 100)", async () => {
      mockBranchUsers([]);

      const defaults = await apiGatewayController.getCouriers(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        registratorReq,
      );
      const capped = await apiGatewayController.getCouriers(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '1',
        '500',
        registratorReq,
      );

      expect(defaults.data.meta).toEqual({
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 1,
      });
      expect(capped.data.meta.limit).toBe(100);
      expect(identityClient.send).not.toHaveBeenCalled();
    });

    it("superadmin yo'li o'zgarmagan: identity user_ids'siz, branch so'rovi yo'q", async () => {
      identityClient.send.mockReturnValue(
        of({
          statusCode: 200,
          message: 'success',
          data: {
            items: [{ id: '263' }],
            meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
          },
        }),
      );
      financeClient.send.mockReturnValue(of({ data: { balance: 0 } }));

      await apiGatewayController.getCouriers(
        undefined,
        undefined,
        '7',
        undefined,
        undefined,
        undefined,
        undefined,
        { user: { sub: '1', username: 'sa', roles: ['superadmin'] } },
      );

      const [, payload] = identityClient.send.mock.calls[0];
      expect(payload.query).toEqual(
        expect.objectContaining({ region_id: '7' }),
      );
      expect(payload.query).not.toHaveProperty('user_ids');
      expect(branchClient.send).not.toHaveBeenCalled();
    });
  });

  /**
   * GET /couriers — kuryer kassasi (balanslar) faqat SUPERADMIN, ADMIN va
   * MANAGER'ga. REGISTRATOR va BRANCH ro'yxatni balanssiz oladi, finance'ga
   * murojaat qilinmaydi.
   */
  describe('getUsers — kuryer ko`lami faqat menejerga (o5jS4rUS)', () => {
    const tenCouriers = Array.from({ length: 10 }, (_, i) => ({
      id: String(100 + i),
      name: `Viloyat kuryer ${i}`,
      role: 'courier',
    }));
    const identityPage = (items: Array<Record<string, unknown>>) =>
      of({
        statusCode: 200,
        data: { items, meta: { page: 1, limit: 200, total: items.length } },
      });

    it('⭐ superadmin: branch so`rovi YO`Q, user_ids yo`q, 10 ta kuryerdan hech biri yashirilmaydi', async () => {
      identityClient.send.mockReturnValue(identityPage(tenCouriers));

      const res: any = await apiGatewayController.getUsers(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '1',
        '200',
        { user: { sub: '1', username: 'sa', roles: ['superadmin'] } } as any,
      );

      const branchCmds = branchClient.send.mock.calls.map(
        ([p]: [{ cmd: string }]) => p.cmd,
      );
      expect(branchCmds).not.toContain('branch.find_hq');
      expect(branchCmds).not.toContain('branch.user.find_by_branch');
      const [, payload] = identityClient.send.mock.calls[0];
      expect(payload.query.user_ids).toBeUndefined();
      expect(res.data.items).toHaveLength(10);
      expect(res.data.meta.total).toBe(10);
    });

    it('⭐ superadmin ?role=courier — /couriers bilan teng (filtrlanmaydi)', async () => {
      identityClient.send.mockReturnValue(identityPage(tenCouriers));
      const res: any = await apiGatewayController.getUsers(
        undefined,
        'courier',
        undefined,
        undefined,
        undefined,
        '1',
        '200',
        { user: { sub: '1', username: 'sa', roles: ['superadmin'] } } as any,
      );
      expect(
        identityClient.send.mock.calls[0][1].query.user_ids,
      ).toBeUndefined();
      expect(res.data.meta.total).toBe(10);
    });

    it('⭐ regressiya: filialga biriktirilgan menejer uchun kuryer ko`lami SAQLANADI', async () => {
      branchClient.send.mockImplementation(({ cmd }: { cmd: string }) => {
        if (cmd === 'branch.user.find_by_user') {
          return of({ data: { branch_id: '3', role: 'MANAGER' } });
        }
        if (cmd === 'branch.user.find_by_branch') {
          return of({ data: [{ user_id: '101', role: 'COURIER' }] });
        }
        return of({ data: null });
      });
      identityClient.send.mockReturnValue(identityPage([tenCouriers[1]]));

      await apiGatewayController.getUsers(
        undefined,
        'courier',
        undefined,
        undefined,
        undefined,
        '1',
        '200',
        { user: { sub: '25', username: 'mgr', roles: ['manager'] } } as any,
      );

      const [, payload] = identityClient.send.mock.calls[0];
      expect(payload.query.user_ids).toEqual(['101']);
    });
  });

  describe('getCouriers — kuryer balanslari kimga ko‘rinadi', () => {
    const courierCashbox = {
      id: 'cb-263',
      user_id: '263',
      cashbox_type: 'couriers',
      balance: 450000,
      balance_cash: 300000,
      balance_card: 150000,
    };

    beforeEach(() => {
      // Filialga bog'langan so'rovchi uchun: filial 1, unda kuryer 263.
      branchClient.send.mockImplementation(({ cmd }: { cmd: string }) => {
        if (cmd === 'branch.user.find_by_user') {
          return of({ data: { branch_id: '1', role: 'REGISTRATOR' } });
        }
        if (cmd === 'branch.user.find_by_branch') {
          return of({ data: [{ user_id: '263', role: 'COURIER' }] });
        }
        return of({ data: null });
      });
      identityClient.send.mockReturnValue(
        of({
          statusCode: 200,
          message: 'success',
          data: {
            items: [{ id: '263', name: 'HQ kuryer', role: 'courier' }],
            meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
          },
        }),
      );
      financeClient.send.mockReturnValue(of({ data: courierCashbox }));
    });

    const listAs = (roles: string[]) =>
      apiGatewayController.getCouriers(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { user: { sub: '500', username: 'u', roles } },
      );

    it.each([['registrator'], ['branch'], ['REGISTRATOR']])(
      "%s: kuryerlar ro'yxati keladi, lekin cashbox (balanslar) yo'q; finance chaqirilmaydi",
      async (role) => {
        const response = await listAs([role]);

        expect(response.data.items).toEqual([
          { id: '263', name: 'HQ kuryer', role: 'courier' },
        ]);
        expect(response.data.items[0]).not.toHaveProperty('cashbox');
        expect(JSON.stringify(response.data)).not.toContain('balance');
        expect(response.data.meta.total).toBe(1);
        expect(financeClient.send).not.toHaveBeenCalled();
      },
    );

    it.each([['superadmin'], ['admin'], ['manager']])(
      '%s: har bir kuryerga FOR_COURIER kassasi (balanslar) qo‘shiladi',
      async (role) => {
        const response = await listAs([role]);

        expect(response.data.items).toEqual([
          expect.objectContaining({ id: '263', cashbox: courierCashbox }),
        ]);
        expect(financeClient.send).toHaveBeenCalledWith(
          { cmd: 'finance.cashbox.find_by_user' },
          { user_id: '263', cashbox_type: 'couriers' },
        );
      },
    );
  });

  /**
   * POST /managers DTO: branch_id faqat raqamlar. Postgres '+1', ' 1 ', '0x1'
   * kabi qiymatlarni ham bigint'ga (HQ'ga) aylantiradi — gateway ularni
   * identity'ga yetib bormasdan 400 bilan qaytaradi.
   */
  describe('CreateManagerRequestDto — branch_id', () => {
    const managerBody = (branchId: unknown) => ({
      name: 'Yangi menejer',
      phone_number: '+998901112233',
      password: 'secret123',
      branch_id: branchId,
    });

    const branchIdErrors = async (branchId: unknown) => {
      const dto = plainToInstance(
        CreateManagerRequestDto,
        managerBody(branchId),
      );
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      return errors.find((error) => error.property === 'branch_id');
    };

    it.each([['1'], ['15'], ['01']])('%p — o‘tadi', async (branchId) => {
      expect(await branchIdErrors(branchId)).toBeUndefined();
    });

    it.each([['+1'], [' 1 '], ['1 '], ['0x1'], ['1e0'], ['-1'], ['abc'], ['']])(
      "%p — 400: o'zbekcha xabar bilan rad etiladi",
      async (branchId) => {
        const error = await branchIdErrors(branchId);

        expect(error?.constraints).toEqual(
          expect.objectContaining({
            matches: "branch_id faqat raqamlardan iborat bo'lishi kerak",
          }),
        );
      },
    );
  });

  /**
   * Item 4 — market_tg_token (marketning Telegram kaliti) identity'dan faqat
   * SUPERADMIN/ADMIN'ning GET /users/:id so'rovida so'raladi. Menejer so'rovida
   * `include_tg_token` kaliti umuman yuborilmaydi.
   */
  describe("getUserById — market_tg_token faqat SUPERADMIN/ADMIN so'rovida so'raladi", () => {
    it.each([['superadmin'], ['admin'], ['SUPERADMIN']])(
      "%s: identity'ga { id, include_tg_token: true }; filial so'rovi yo'q",
      async (role) => {
        await apiGatewayController.getUserById('3', {
          user: { sub: '1', username: 'sa', roles: [role] },
        });

        expect(identityClient.send).toHaveBeenCalledWith(
          { cmd: 'identity.user.find_by_id' },
          { id: '3', include_tg_token: true },
        );
        expect(branchClient.send).not.toHaveBeenCalled();
      },
    );

    it("REGIONAL filial menejeri o'z kuryerini ko'radi: payload AYNAN { id } — flag yo'q", async () => {
      branchClient.send
        .mockReturnValueOnce(
          of({
            data: { branch_id: '6', branch: { id: '6', type: 'REGIONAL' } },
          }),
        )
        .mockReturnValueOnce(
          of({ data: [{ user_id: '42', role: 'COURIER' }] }),
        );

      await apiGatewayController.getUserById('42', {
        user: { sub: '19', username: 'm', roles: ['manager'] },
      });

      expect(identityClient.send).toHaveBeenCalledTimes(1);
      const [pattern, payload] = identityClient.send.mock.calls[0];
      expect(pattern).toEqual({ cmd: 'identity.user.find_by_id' });
      expect(payload).toStrictEqual({ id: '42' });
      expect(payload).not.toHaveProperty('include_tg_token');
    });
  });

  /**
   * DELETE /users/:id — 15 s: identity kuryerni o'chirishdan oldin filial
   * tekshiruvini (branch.user.courier_transfer_check) 12 s gacha kutadi.
   * Gateway limiti undan qisqa bo'lsa, mijoz aniq 409/503 o'rniga 504 olardi.
   */
  describe('deleteUser — timeout 15 s', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('identity javob bermasa: 8 s da hali kutadi, 15 s da TimeoutError', () => {
      jest.useFakeTimers();
      identityClient.send.mockReturnValue(NEVER);
      const errors: unknown[] = [];

      const subscription = apiGatewayController
        .deleteUser('263', {
          user: { sub: '1', username: 'sa', roles: ['superadmin'] },
        })
        .subscribe({
          error: (error: unknown) => {
            errors.push(error);
          },
        });

      jest.advanceTimersByTime(8_000);
      expect(errors).toHaveLength(0);
      jest.advanceTimersByTime(6_999);
      expect(errors).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(TimeoutError);
      subscription.unsubscribe();

      expect(identityClient.send).toHaveBeenCalledWith(
        { cmd: 'identity.user.delete' },
        { id: '263', requester: { id: '1', roles: ['superadmin'] } },
      );
    });
  });

  /**
   * wUHQrZko — POST /couriers dagi branch_id jimgina e'tiborsiz qolardi:
   * superadmin '13' yuborsa 201, kuryer esa HQ'ga tushardi. Endi mos kelmasa
   * 400; mos kelsa (menejer UI'si o'z filialini yuboradi) avvalgidek.
   */
  describe('createCourier — branch_id jimgina tashlanmaydi', () => {
    const body = (branchId?: string) =>
      ({
        name: 'TEST-KURYER',
        phone_number: '+998901112233',
        password: 'secret123',
        tariff_home: 10000,
        tariff_center: 8000,
        ...(branchId ? { branch_id: branchId } : {}),
      }) as never;
    const SA = { user: { sub: '1', username: 'sa', roles: ['superadmin'] } };
    const MANAGER = { user: { sub: '19', username: 'm', roles: ['manager'] } };

    const mockHq = () =>
      branchClient.send.mockImplementation((pattern: { cmd: string }) =>
        pattern.cmd === 'branch.find_hq'
          ? of({ data: { id: '1' } })
          : of({ data: { id: '1', type: 'HQ', region_id: '' } }),
      );

    it.each([['13'], ['2']])(
      '⭐ superadmin branch_id=%p (HQ emas) — 400, kuryer yaratilmaydi',
      async (branchId) => {
        mockHq();

        await expect(
          apiGatewayController.createCourier(body(branchId), SA as never),
        ).rejects.toMatchObject({ status: 400 });
        expect(identityClient.send).not.toHaveBeenCalled();
      },
    );

    it('superadmin branch_id yubormasa yoki HQ ni yuborsa — HQ da yaratiladi', async () => {
      for (const branchId of [undefined, '1']) {
        identityClient.send.mockClear();
        mockHq();

        await apiGatewayController.createCourier(body(branchId), SA as never);

        expect(identityClient.send).toHaveBeenCalledWith(
          { cmd: 'identity.courier.create' },
          expect.objectContaining({
            dto: expect.objectContaining({ branch_id: '1' }),
          }),
        );
      }
    });

    it('menejer: o`z filiali — o`tadi; boshqa filial — 400', async () => {
      branchClient.send.mockImplementation((pattern: { cmd: string }) =>
        pattern.cmd === 'branch.find_by_id'
          ? of({ data: { id: '6', type: 'REGIONAL', region_id: '3' } })
          : of({
              data: { branch_id: '6', branch: { id: '6', type: 'REGIONAL' } },
            }),
      );

      await apiGatewayController.createCourier(body('6'), MANAGER as never);
      expect(identityClient.send).toHaveBeenCalledWith(
        { cmd: 'identity.courier.create' },
        expect.objectContaining({
          dto: expect.objectContaining({ branch_id: '6', region_id: '3' }),
        }),
      );

      identityClient.send.mockClear();
      await expect(
        apiGatewayController.createCourier(body('13'), MANAGER as never),
      ).rejects.toMatchObject({ status: 400 });
      expect(identityClient.send).not.toHaveBeenCalled();
    });
  });
});
