import { RpcException } from '@nestjs/microservices';
import { NotificationCategory, NotificationPriority } from '@app/common';
import {
  NotificationPreferencesService,
  effectiveMutes,
  isMutableNotification,
} from './notification-preferences.service';

/** (mP1WGG1W) Sozlamalar filtri va API. */
describe('NotificationPreferencesService (mP1WGG1W)', () => {
  let repo: any;
  let qb: any;
  let rawRows: Array<Record<string, unknown>>;
  let insertQb: any;
  let service: NotificationPreferencesService;

  const rpcError = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode: number;
        message: string;
      };
    }
    throw new Error('RpcException kutilgan edi');
  };

  beforeEach(() => {
    rawRows = [];
    qb = {
      select: jest.fn(() => qb),
      addSelect: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      getRawMany: jest.fn(() => Promise.resolve(rawRows)),
    };
    insertQb = {
      insert: jest.fn(() => insertQb),
      into: jest.fn(() => insertQb),
      values: jest.fn(() => insertQb),
      orUpdate: jest.fn(() => insertQb),
      execute: jest.fn().mockResolvedValue({}),
    };
    const manager = {
      createQueryBuilder: jest.fn(() => insertQb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    repo = {
      createQueryBuilder: jest.fn(() => qb),
      find: jest.fn().mockResolvedValue([]),
      manager: {
        transaction: jest.fn((work: (m: unknown) => Promise<unknown>) =>
          work(manager),
        ),
        _inner: manager,
      },
    };
    service = new NotificationPreferencesService(repo);
  });

  const ctx = (
    type: string,
    category: NotificationCategory,
    channels = ['in_app', 'realtime', 'push'],
    priority: NotificationPriority = NotificationPriority.NORMAL,
  ) => ({ type, category, priority, channels });

  describe('mutesFor — dispatch filtri', () => {
    it('TC4: `marketing` uchun yozuv yo‘q → qabul qiluvchi TUSHMAYDI (default o‘chiq, fail-closed)', async () => {
      const res = await service.mutesFor(
        ['1', '2'],
        ctx('marketing.promo', NotificationCategory.MARKETING),
      );
      expect(res.get('1')).toBe('all');
      expect(res.get('2')).toBe('all');
    });

    it('marketing: rozilik bergan (enabled=true) qabul qiluvchi tushadi', async () => {
      rawRows = [
        { user_id: '2', scope: 'marketing', channel: 'all', enabled: true },
      ];
      const res = await service.mutesFor(
        ['1', '2'],
        ctx('marketing.promo', NotificationCategory.MARKETING),
      );
      expect(res.get('1')).toBe('all');
      expect(res.has('2')).toBe(false);
    });

    it('TC5: xodim xabari uchun yozuv yo‘q → qabul qiluvchi TUSHADI (default yoqiq)', async () => {
      const res = await service.mutesFor(
        ['1'],
        ctx('order.sold', NotificationCategory.ORDER),
      );
      expect(res.size).toBe(0);
    });

    it('TC6: user_can_mute=false (critical) — sozlamaga qaramay yetkaziladi, so‘rov ham yo‘q', async () => {
      rawRows = [
        { user_id: '1', scope: 'account', channel: 'all', enabled: false },
      ];
      const res = await service.mutesFor(
        ['1'],
        ctx(
          'account.password_changed',
          NotificationCategory.ACCOUNT,
          ['in_app'],
          NotificationPriority.CRITICAL,
        ),
      );
      expect(res.size).toBe(0);
      expect(qb.getRawMany).not.toHaveBeenCalled();
      // Qo'lda yuborilgan critical ham o'chirilmaydi, lekin marketing — DOIM sozlamada.
      expect(
        isMutableNotification({
          type: 'order.manual',
          category: 'order',
          priority: 'critical',
        }),
      ).toBe(false);
      expect(
        isMutableNotification({
          type: 'marketing.manual',
          category: 'marketing',
          priority: 'critical',
        }),
      ).toBe(true);
    });

    it('TC7: 1000 qabul qiluvchi — filtr uchun ATIGI 1 ta SQL (user_id = ANY, is_deleted=false)', async () => {
      const ids = Array.from({ length: 1000 }, (_, i) => String(i + 1));
      rawRows = [
        { user_id: '7', scope: 'order', channel: 'push', enabled: false },
      ];
      const res = await service.mutesFor(
        ids,
        ctx('order.sold', NotificationCategory.ORDER),
      );
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(qb.getRawMany).toHaveBeenCalledTimes(1);
      expect(qb.where).toHaveBeenCalledWith(
        'p.user_id = ANY(CAST(:ids AS bigint[]))',
        { ids },
      );
      expect(qb.andWhere).toHaveBeenCalledWith('p.scope IN (:...scopes)', {
        scopes: ['order.sold', 'order'],
      });
      expect(qb.andWhere).toHaveBeenCalledWith('p.isDeleted = false');
      expect([...(res.get('7') as Set<string>)]).toEqual(['push']);
      expect(res.size).toBe(1);
    });

    it('ustuvorlik: aniq tur > kategoriya; aniq kanal > all', () => {
      const rows = [
        { scope: 'order', channel: 'all', enabled: false },
        { scope: 'order.sold', channel: 'in_app', enabled: true },
        { scope: 'order.sold', channel: 'realtime', enabled: true },
      ];
      expect(
        effectiveMutes(rows, ctx('order.sold', NotificationCategory.ORDER)),
      ).toEqual(new Set(['push']));
      expect(
        effectiveMutes(rows, ctx('order.created', NotificationCategory.ORDER)),
      ).toBe('all');
    });

    it('telegram (guruh relay) sozlamaga tushmaydi', () => {
      const rows = [{ scope: 'order', channel: 'push', enabled: false }];
      expect(
        effectiveMutes(
          rows,
          ctx('order.cancelled', NotificationCategory.ORDER, [
            'in_app',
            'telegram',
            'push',
          ]),
        ),
      ).toEqual(new Set(['push']));
    });
  });

  describe('get / update — API', () => {
    it('TC10: get faqat berilgan (JWT) user_id bo‘yicha o‘qiydi; user_id yo‘q — 400', async () => {
      repo.find.mockResolvedValue([
        {
          scope: 'order',
          channel: 'push',
          enabled: false,
          updatedAt: new Date('2026-10-14T00:00:00Z'),
        },
      ]);
      const res: any = await service.get({ user_id: '42' });
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: '42', isDeleted: false },
        }),
      );
      expect(res.data.items).toEqual([
        {
          scope: 'order',
          channel: 'push',
          enabled: false,
          updated_at: new Date('2026-10-14T00:00:00Z'),
        },
      ]);
      expect(res.data.defaults).toEqual({ marketing: false, other: true });
      expect(res.data.locked_types).toContain('account.password_changed');
      expect((await rpcError(service.get({}))).statusCode).toBe(400);
    });

    it('TC11: critical turni o‘chirishga urinish — 400, hech narsa yozilmaydi', async () => {
      const error = await rpcError(
        service.update({
          user_id: '42',
          items: [
            {
              scope: 'account.password_changed',
              channel: 'all',
              enabled: false,
            },
          ],
        }),
      );
      expect(error.statusCode).toBe(400);
      expect(insertQb.execute).not.toHaveBeenCalled();
    });

    it('update: UPSERT (user_id, scope, channel) bo‘yicha — takror kalit bitta qatorga', async () => {
      await service.update({
        user_id: '42',
        items: [
          { scope: 'order', channel: 'push', enabled: true },
          { scope: 'order', channel: 'push', enabled: false },
          { scope: 'marketing', channel: 'all', enabled: true },
        ],
      });
      expect(insertQb.values).toHaveBeenCalledWith([
        {
          user_id: '42',
          scope: 'order',
          channel: 'push',
          enabled: false,
          isDeleted: false,
        },
        {
          user_id: '42',
          scope: 'marketing',
          channel: 'all',
          enabled: true,
          isDeleted: false,
        },
      ]);
      expect(insertQb.orUpdate).toHaveBeenCalledWith(
        ['enabled', 'is_deleted', 'updatedAt'],
        ['user_id', 'scope', 'channel'],
      );
    });

    it('update: enabled=null — sukutga qaytarish (soft-delete)', async () => {
      await service.update({
        user_id: '42',
        items: [{ scope: 'order', channel: 'push', enabled: null }],
      });
      expect(insertQb.execute).not.toHaveBeenCalled();
      expect(repo.manager._inner.update).toHaveBeenCalledWith(
        expect.anything(),
        { user_id: '42', scope: 'order', channel: 'push' },
        { isDeleted: true },
      );
    });

    it('update: noma’lum scope / kanal / enabled turi — 400', async () => {
      for (const item of [
        { scope: 'nope', channel: 'push', enabled: false },
        { scope: 'order', channel: 'fax', enabled: false },
        { scope: 'order', channel: 'telegram', enabled: false },
        { scope: 'order', channel: 'push', enabled: 'no' },
        { scope: 'x.test', channel: 'push', enabled: false },
      ]) {
        expect(
          (await rpcError(service.update({ user_id: '42', items: [item] })))
            .statusCode,
        ).toBe(400);
      }
      expect(
        (await rpcError(service.update({ user_id: '42', items: [] })))
          .statusCode,
      ).toBe(400);
    });
  });
});
