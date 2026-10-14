/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';

/**
 * C4R3YyvH — `users.language` (uz | ru | en): profil tahrirlashda tanlanadi
 * va saqlanadi (TC16), mijoz yozuvida ham ishlaydi (TC17). DB CHECK —
 * migratsiya 085 (notification-templates.pg.spec.ts).
 */
function buildSvc(row: Record<string, unknown> | null) {
  const svc: any = Object.create(UserServiceService.prototype);
  svc.users = {
    findOne: jest.fn().mockResolvedValue(row),
    create: jest.fn((v: unknown) => v),
    save: jest.fn((u: unknown) => Promise.resolve(u)),
  };
  svc.assertRequesterCanMutateUser = jest.fn();
  svc.syncUserToSearch = jest.fn();
  svc.sanitize = (u: unknown) => u;
  svc.activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  svc.bcryptEncryption = { encrypt: jest.fn().mockResolvedValue('hash') };
  return svc;
}

const courier = () => ({
  id: '7',
  role: Roles.COURIER,
  status: Status.ACTIVE,
  language: 'uz',
  isDeleted: false,
});
const self = { id: '7', roles: [Roles.COURIER] };

describe('C4R3YyvH — users.language', () => {
  it('TC16: foydalanuvchi o‘z profilida tilni tanlaydi va saqlanadi (audit before/after bilan)', async () => {
    const svc = buildSvc(courier());
    await svc.updateUser('7', { language: 'ru' }, self);
    expect(svc.users.save.mock.calls[0][0].language).toBe('ru');
    const change = svc.activityLog.logChange.mock.calls[0][0];
    expect(change.old_value.language).toBe('uz');
    expect(change.new_value.language).toBe('ru');
  });

  it('ruxsat etilmagan til — 400 (RMQ’da ValidationPipe yo‘q, servis tekshiradi), saqlanmaydi', async () => {
    const svc = buildSvc(courier());
    await expect(
      svc.updateUser('7', { language: 'de' }, self),
    ).rejects.toBeInstanceOf(RpcException);
    expect(svc.users.save).not.toHaveBeenCalled();
  });

  it('DTO: language faqat uz/ru/en', async () => {
    const ok = await validate(
      plainToInstance(UpdateUserDto, { language: 'en' }),
    );
    const bad = await validate(
      plainToInstance(UpdateUserDto, { language: 'kk' }),
    );
    expect(ok).toHaveLength(0);
    expect(bad.map((e) => e.property)).toEqual(['language']);
    const badCustomer = await validate(
      plainToInstance(CreateCustomerDto, {
        name: 'A',
        phone_number: '+998901112233',
        district_id: '1',
        language: 'tr',
      }),
    );
    expect(badCustomer.map((e) => e.property)).toEqual(['language']);
  });

  it('TC17: yangi mijoz — buyurtma manbasidagi til yoki sukut uz', async () => {
    const svc = buildSvc(null);
    await svc.createCustomer({
      name: 'Mijoz',
      phone_number: '+998901112233',
      district_id: '1',
      language: 'ru',
    });
    expect(svc.users.create.mock.calls[0][0].language).toBe('ru');
    const svc2 = buildSvc(null);
    await svc2.createCustomer({
      name: 'Mijoz',
      phone_number: '+998901112234',
      district_id: '1',
    });
    expect(svc2.users.create.mock.calls[0][0].language).toBe('uz');
  });

  it('TC17: mavjud mijoz — berilgan til yangilanadi, berilmasa/noto‘g‘ri bo‘lsa o‘zgarmaydi', async () => {
    const existing = () => ({
      id: 'c1',
      role: Roles.CUSTOMER,
      name: 'Mijoz',
      phone_number: '+998901112233',
      district_id: '1',
      language: 'uz',
    });
    const svc = buildSvc(existing());
    await svc.createCustomer({
      name: 'Mijoz',
      phone_number: '+998901112233',
      district_id: '1',
      language: 'en',
    });
    expect(svc.users.save.mock.calls[0][0].language).toBe('en');
    for (const language of [undefined, 'xx']) {
      const other = buildSvc(existing());
      await other.createCustomer({
        name: 'Mijoz',
        phone_number: '+998901112233',
        district_id: '1',
        language,
      });
      expect(other.users.save).not.toHaveBeenCalled();
    }
  });
});
