/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { UserServiceService } from './user-service.service';

/**
 * createCustomer — mavjud mijoz telefon bo'yicha topilsa, berilgan va farq
 * qiladigan maydonlar YANGILANADI (j70YS4zJ). Ilgari hech narsa yangilanmasdi
 * va kuryer eski ism/tumanni ko'rardi.
 */
function buildSvc(existing: any, saveImpl?: jest.Mock) {
  const svc: any = Object.create(UserServiceService.prototype);
  svc.users = {
    findOne: jest.fn().mockResolvedValue(existing),
    save: saveImpl ?? jest.fn((u: any) => Promise.resolve(u)),
  };
  svc.syncUserToSearch = jest.fn();
  svc.sanitize = (u: any) => u;
  svc.conflict = (m: string) => {
    throw new Error(m);
  };
  return svc;
}

const CUSTOMER = () => ({
  id: 'c-1',
  role: 'customer',
  name: 'Eski Ism',
  phone_number: '+998901112233',
  district_id: 'd-old',
  address: 'Eski manzil',
  extra_number: null,
});

describe('UserServiceService.createCustomer — mavjudni yangilash', () => {
  it('yangi ism/tuman berilsa -> patch qilinadi va saqlanadi', async () => {
    const svc = buildSvc(CUSTOMER());
    const res = await svc.createCustomer({
      phone_number: '+998901112233',
      name: 'Yangi Ism',
      district_id: 'd-new',
    });
    expect(svc.users.save).toHaveBeenCalledTimes(1);
    const saved = svc.users.save.mock.calls[0][0];
    expect(saved.name).toBe('Yangi Ism');
    expect(saved.district_id).toBe('d-new');
    expect(saved.address).toBe('Eski manzil'); // berilmagan -> saqlanadi
    expect(res.statusCode ?? res.status ?? 200).toBeDefined();
  });

  it('bir xil qiymatlar -> saqlanmaydi (allaqachon mavjud)', async () => {
    const svc = buildSvc(CUSTOMER());
    await svc.createCustomer({
      phone_number: '+998901112233',
      name: 'Eski Ism',
      district_id: 'd-old',
    });
    expect(svc.users.save).not.toHaveBeenCalled();
  });

  it('ism berilmasa (undefined) -> eski ism O`CHIRILMAYDI', async () => {
    const svc = buildSvc(CUSTOMER());
    await svc.createCustomer({
      phone_number: '+998901112233',
      district_id: 'd-new',
    });
    const saved = svc.users.save.mock.calls[0][0];
    expect(saved.name).toBe('Eski Ism'); // o'chirilmadi
    expect(saved.district_id).toBe('d-new');
  });
});
