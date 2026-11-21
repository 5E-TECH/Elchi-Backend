/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { Roles } from '@app/common';
import {
  BcryptEncryption,
  PASSWORD_LOGIN_DISABLED,
} from '../../../libs/common/helpers/bcrypt';
import { UserServiceService } from './user-service.service';

/**
 * createCustomer — yangi mijozga bcrypt xeshi HISOBLANMAYDI.
 *
 * Mijoz parol bilan kirmaydi. Ilgari hech kimga berilmaydigan tasodifiy parol
 * bcryptjs (sof JS, narx 12) bilan xeshlanib, identity event loop'ini har
 * buyurtmadagi yangi mijozda band qilardi — shu jarayondagi gateway sessiya
 * tekshiruvi ham kechikardi. Endi `password` = `PASSWORD_LOGIN_DISABLED`.
 */
function buildSvc() {
  const svc: any = Object.create(UserServiceService.prototype);
  svc.users = {
    findOne: jest.fn(async () => null),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn(async (value: Record<string, unknown>) => ({
      id: '900',
      ...value,
    })),
  };
  svc.bcryptEncryption = new BcryptEncryption();
  jest.spyOn(svc.bcryptEncryption, 'encrypt');
  svc.activityLog = { log: jest.fn(async () => undefined) };
  svc.syncUserToSearch = jest.fn();
  svc.sanitize = (u: Record<string, unknown>) => u;
  return svc;
}

describe('createCustomer — parol bilan kirish yopiq marker', () => {
  it('yangi mijoz: bcrypt chaqirilmaydi, password = PASSWORD_LOGIN_DISABLED', async () => {
    const svc = buildSvc();
    await svc.createCustomer({
      name: 'TEST mijoz',
      phone_number: '+998901112233',
      district_id: '173',
    });

    expect(svc.bcryptEncryption.encrypt).not.toHaveBeenCalled();
    expect(svc.users.create).toHaveBeenCalledTimes(1);
    const created = svc.users.create.mock.calls[0][0];
    expect(created.role).toBe(Roles.CUSTOMER);
    expect(created.password).toBe(PASSWORD_LOGIN_DISABLED);
  });

  it('marker hech qaysi parolga mos kelmaydi — o‘zi ham, bo‘sh satr ham', async () => {
    const bcrypt = new BcryptEncryption();
    await expect(
      bcrypt.compare(PASSWORD_LOGIN_DISABLED, PASSWORD_LOGIN_DISABLED),
    ).resolves.toBe(false);
    await expect(bcrypt.compare('', PASSWORD_LOGIN_DISABLED)).resolves.toBe(
      false,
    );
  });
});
