import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

/**
 * 2026-11-12 (Dilshod: «Qabul va aralash managerlar market yarata olsin va
 * o'zi yaratgan marketlarni foydalanuvchilar ro'yxatida ko'rib tursin»):
 *  - POST /markets — PICKUP («Qabul punkti») va HYBRID («Aralash») filial
 *    menejeri; boshqa turlar va biriktirilmagan menejer — 403;
 *  - GET /users/:id — o'zi yaratgan market (created_by = menejer) filial
 *    a'zoligi va filial turisiz ochiladi; boshqaning marketi — eski tekshiruv.
 */
type Row = Record<string, unknown>;
type Pattern = { cmd: string };

const manager = (sub = '25') => ({
  user: { sub, username: 'mgr', roles: ['manager'] },
});

describe('2026-11-12 — qabul/aralash menejer marketlari', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };
  let target: Row | null;

  const assignment = (type: string | null) =>
    branchClient.send.mockImplementation(({ cmd }: Pattern) => {
      if (cmd === 'branch.user.find_by_user') {
        return of({
          data: type ? { branch_id: '3', branch: { id: '3', type } } : null,
        });
      }
      if (cmd === 'branch.user.find_by_branch') {
        return of({ data: [{ user_id: '101', role: 'COURIER' }] });
      }
      return of({ data: null });
    });

  beforeEach(async () => {
    target = null;
    identityClient = {
      send: jest.fn(({ cmd }: Pattern) => {
        if (cmd === 'identity.user.find_by_id') {
          return of({ statusCode: 200, data: target });
        }
        return of({ statusCode: 201, data: { id: '700', role: 'market' } });
      }),
    };
    branchClient = { send: jest.fn() };
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: identityClient },
        { provide: 'FINANCE', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: branchClient },
      ],
    }).compile();
    controller = app.get(ApiGatewayController);
  });

  const createMarket = (req: Row) =>
    controller.createMarket(
      { name: 'Yangi market', phone_number: '+998901112233' } as never,
      req as never,
    );
  const marketCreateCalls = () =>
    identityClient.send.mock.calls.filter(
      ([p]: [Pattern]) => p.cmd === 'identity.market.create',
    );

  describe('POST /markets', () => {
    it.each([['PICKUP'], ['HYBRID'], ['pickup']])(
      '⭐ %s filial menejeri market yaratadi (created_by = menejer)',
      async (type) => {
        assignment(type);

        await createMarket(manager());

        expect(marketCreateCalls()).toHaveLength(1);
        const [, payload] = marketCreateCalls()[0] as [Pattern, Row];
        expect(payload.requester).toMatchObject({ id: '25' });
      },
    );

    it.each([['REGIONAL'], ['CITY'], ['DISTRICT'], ['HQ']])(
      '%s filial menejeri — 403, identity chaqirilmaydi',
      async (type) => {
        assignment(type);

        await expect(createMarket(manager())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(marketCreateCalls()).toHaveLength(0);
      },
    );

    it('filialga biriktirilmagan menejer — 403', async () => {
      assignment(null);

      await expect(createMarket(manager())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(marketCreateCalls()).toHaveLength(0);
    });

    it('superadmin — filial tekshiruvisiz', async () => {
      await createMarket({ user: { sub: '1', roles: ['superadmin'] } });

      expect(marketCreateCalls()).toHaveLength(1);
      expect(branchClient.send).not.toHaveBeenCalled();
    });
  });

  describe('GET /users/:id', () => {
    it('⭐ o`zi yaratgan market — PICKUP menejeriga ham ochiladi, filial so`ralmaydi', async () => {
      assignment('PICKUP');
      target = { id: '700', role: 'market', created_by: '25', name: 'M' };

      const res = (await controller.getUserById('700', manager())) as {
        data: Row;
      };

      expect(res.data).toMatchObject({ id: '700', role: 'market' });
      expect(branchClient.send).not.toHaveBeenCalled();
    });

    it('boshqa menejer yaratgan market — 403 (eski filial tekshiruvi)', async () => {
      assignment('HYBRID');
      target = { id: '701', role: 'market', created_by: '26' };

      await expect(
        controller.getUserById('701', manager()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('o`zi yaratgan, lekin market emas (kuryer) — filial tekshiruvi ishlaydi', async () => {
      assignment('PICKUP');
      target = { id: '101', role: 'courier', created_by: '25' };

      // PICKUP — foydalanuvchi ko'rish ruxsati yo'q (avvalgidek).
      await expect(
        controller.getUserById('101', manager()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('identity javobsiz (null) — fail-closed: filial tekshiruvi, 403', async () => {
      assignment('HYBRID');
      target = null;

      await expect(
        controller.getUserById('702', manager()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
