import { In } from 'typeorm';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import { IdentityController } from './identity.controller';

/**
 * y8CxCtcK / fQi6NNUL — `identity.user.summary_by_ids`: faoliyat jurnali
 * "Kim" ustuni uchun ichki batch.
 *  • rol filtri YO'Q (superadmin, mijoz ham);
 *  • telefon/username/status/parol QAYTMAYDI — faqat `{ id, name, role }`;
 *  • `findAllAdmins` (GET /users) dagi rol filtri O'ZGARMAGAN (regress).
 */
describe('findUserSummariesByIds (y8CxCtcK)', () => {
  const superadmin = {
    id: '1',
    name: 'Dilshod',
    username: 'dilshod',
    phone_number: '+998900000001',
    role: Roles.SUPERADMIN,
    status: Status.ACTIVE,
    password: 'hash',
    isDeleted: false,
  };
  const customer = {
    id: '900',
    name: 'Mijoz',
    phone_number: '+998901112233',
    role: Roles.CUSTOMER,
    isDeleted: true,
  };

  function make(rows: Record<string, unknown>[]) {
    const svc: any = Object.create(UserServiceService.prototype);
    svc.users = { find: jest.fn().mockResolvedValue(rows) };
    return svc;
  }

  it('⭐ superadmin va mijoz qaytadi; SELECT faqat id/name/role; telefon YO`Q', async () => {
    const svc = make([superadmin, customer]);

    const res = await svc.findUserSummariesByIds(['1', '900', '1', 'x', -3]);

    const arg = svc.users.find.mock.calls[0][0];
    expect(arg.where).toEqual({ id: In(['1', '900']) });
    expect(arg.where).not.toHaveProperty('role');
    expect(arg.select).toEqual({ id: true, name: true, role: true });
    expect(res.data).toEqual([
      { id: '1', name: 'Dilshod', role: Roles.SUPERADMIN },
      { id: '900', name: 'Mijoz', role: Roles.CUSTOMER },
    ]);
    expect(JSON.stringify(res)).not.toMatch(/phone|\+998|password|username/);
  });

  it('o`chirilgan foydalanuvchi ham hal qilinadi (eski amallari ismli qoladi)', async () => {
    const svc = make([customer]);
    await svc.findUserSummariesByIds(['900']);
    expect(svc.users.find.mock.calls[0][0].where).not.toHaveProperty(
      'isDeleted',
    );
  });

  it('bo`sh/yaroqsiz ro`yxat — DB ga bormaydi', async () => {
    const svc = make([]);
    expect(await svc.findUserSummariesByIds(undefined)).toEqual({
      success: true,
      data: [],
    });
    expect(svc.users.find).not.toHaveBeenCalled();
  });

  it('controller: identity.user.summary_by_ids → findUserSummariesByIds', async () => {
    const userService = {
      findUserSummariesByIds: jest.fn().mockResolvedValue({ data: [] }),
    };
    const controller = new IdentityController(
      { ack: jest.fn() } as never,
      userService as never,
      {} as never,
      {} as never,
    );
    const ctx = {
      getChannelRef: () => ({ ack: jest.fn() }),
      getMessage: () => ({}),
    };
    await controller.getUserSummariesByIds({ ids: ['1'] }, ctx as never);
    expect(userService.findUserSummariesByIds).toHaveBeenCalledWith(['1']);
  });

  it('⭐ regress: findAllAdmins dagi superadmin/mijoz filtri o`zgarmagan (GET /users)', async () => {
    const svc: any = Object.create(UserServiceService.prototype);
    const where: Array<[string, unknown]> = [];
    const qb: any = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'andWhere' || prop === 'where') {
            return (sql: string, params: unknown) => {
              where.push([sql, params]);
              return qb;
            };
          }
          if (prop === 'getManyAndCount') return () => Promise.resolve([[], 0]);
          if (prop === 'getMany') return () => Promise.resolve([]);
          if (prop === 'getCount') return () => Promise.resolve(0);
          if (prop === 'then') return undefined;
          return () => qb;
        },
      },
    );
    svc.users = { createQueryBuilder: jest.fn(() => qb) };
    try {
      await svc.findAllAdmins({ page: 1, limit: 10 });
    } catch {
      // Javob shakli bu testda muhim emas — faqat WHERE shartlari.
    }
    const sqls = where.map(([sql]) => sql).join(' | ');
    expect(sqls).toContain('admin.role != :superadminRole');
    expect(sqls).toContain('admin.role != :customerRole');
  });
});
