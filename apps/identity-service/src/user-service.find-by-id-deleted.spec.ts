import { UserServiceService } from './user-service.service';

/**
 * (i76gGjyq) O'chirilgan market operatorining buyurtmasi keyin sotilsa,
 * finance komissiyani olish uchun `identity.user.find_by_id` ni chaqiradi.
 * Ilgari u 404 olardi va `finance.*` outbox hodisasi cheksiz qayta urinardi.
 */
describe('findUserById — include_deleted (i76gGjyq)', () => {
  const deleted = {
    id: '77',
    role: 'market_operator',
    isDeleted: true,
    commission_type: 'percent',
    commission_value: 5,
    password: 'hash',
    refresh_token: 'rt',
    region_id: null,
  };

  function make() {
    const svc: any = Object.create(UserServiceService.prototype);
    svc.users = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          where.id === '77' && where.isDeleted !== false ? deleted : null,
        ),
      ),
    };
    svc.getRegionById = jest.fn(() => Promise.resolve(null));
    return svc;
  }

  it('sukut: o`chirilgan foydalanuvchi → 404 (o`zgarmagan)', async () => {
    const svc = make();
    await expect(svc.findUserById('77')).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 404 }),
    });
  });

  it('includeDeleted: komissiya maydonlari qaytadi, sirlar yo`q', async () => {
    const svc = make();
    const res = await svc.findUserById('77', { includeDeleted: true });
    expect(res.data).toMatchObject({
      id: '77',
      commission_type: 'percent',
      commission_value: 5,
    });
    expect(res.data).not.toHaveProperty('password');
    expect(res.data).not.toHaveProperty('refresh_token');
  });
});
