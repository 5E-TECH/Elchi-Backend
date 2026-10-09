import { In } from 'typeorm';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import { IdentityController } from './identity.controller';

/**
 * (2WRzdWpZ topilma, audit-actor-name) Gateway faoliyat jurnali "Kim"
 * ustunini `identity.user.find_all` orqali to'ldirardi — u SUPERADMIN va
 * mijozni ataylab chiqarib tashlaydi (GET /users ro'yxati), shuning uchun
 * superadmin amallari UI'da ism o'rniga "1" bo'lib ko'rinardi.
 *
 * `identity.user.find_by_ids` — ichki batch: rol filtri YO'Q (superadmin
 * ham), faqat o'chirilmaganlar, faqat UI'ga kerakli qisqa maydonlar.
 */
describe('findUsersByIds — audit actor (2WRzdWpZ)', () => {
  const superadmin = {
    id: '1',
    name: 'Dilshod',
    username: 'dilshod',
    phone_number: '+998900000001',
    role: Roles.SUPERADMIN,
    status: Status.ACTIVE,
    password: 'hash',
    refresh_token: 'rt',
    market_tg_token: '123:tok',
    address: 'Toshkent, ...',
    isDeleted: false,
  };

  function make(rows: Record<string, unknown>[] = [superadmin]) {
    const svc: any = Object.create(UserServiceService.prototype);
    svc.users = { find: jest.fn().mockResolvedValue(rows) };
    return svc;
  }

  it('superadmin qaytadi: rol filtri yo`q, o`chirilganlar chiqarib tashlanadi', async () => {
    const svc = make();

    const res = await svc.findUsersByIds(['1', '1', 37]);

    const arg = svc.users.find.mock.calls[0][0];
    expect(arg.where).toEqual({ id: In(['1', '37']), isDeleted: false });
    expect(arg.where).not.toHaveProperty('role');
    expect(res.data).toEqual([
      {
        id: '1',
        name: 'Dilshod',
        username: 'dilshod',
        phone_number: '+998900000001',
        role: Roles.SUPERADMIN,
        status: Status.ACTIVE,
      },
    ]);
  });

  it('sirlar va ortiqcha maydonlar (parol/token/manzil) qaytmaydi', async () => {
    const svc = make();

    const res = await svc.findUsersByIds(['1']);

    const row = res.data[0];
    for (const key of [
      'password',
      'refresh_token',
      'market_tg_token',
      'address',
      'isDeleted',
    ]) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it.each([
    ['bo`sh', []],
    ['massiv emas', '1'],
    ['buzuq id lar', ['system', 'partner:2', '1.5', '99999999999999999999']],
  ])('%s — DB so`rovi yo`q, bo`sh ro`yxat', async (_l, ids) => {
    const svc = make();

    const res = await svc.findUsersByIds(ids);

    expect(res).toEqual({ success: true, data: [] });
    expect(svc.users.find).not.toHaveBeenCalled();
  });

  it('RPC identity.user.find_by_ids servisga ids ni uzatadi', async () => {
    const userService = {
      findUsersByIds: jest.fn().mockResolvedValue({ success: true, data: [] }),
    };
    const controller = new IdentityController(
      { ack: jest.fn(), nackForError: jest.fn() } as any,
      userService as any,
      {} as any,
      {} as any,
    );
    const context = { getPattern: () => 'x' } as any;

    await controller.getUsersByIds({ ids: ['1'] }, context);

    expect(userService.findUsersByIds).toHaveBeenCalledWith(['1']);
  });
});
