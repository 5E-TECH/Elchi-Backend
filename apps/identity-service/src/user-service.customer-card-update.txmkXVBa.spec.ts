/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { UserServiceService } from './user-service.service';

/**
 * txmkXVBa (ega qarori 2026-10-19 S5) — identity tomoni:
 *  - `createCustomer(dto, { updateExisting: false })` (POST /orders, ai-confirm)
 *    mavjud kartani JIMGINA yozmaydi; sukut (bot, hamkor, import) — avvalgidek
 *    j70YS4zJ patch;
 *  - `updateCustomerCard` («Kartani ham yangilash») — faqat berilgan va farq
 *    qiladigan maydonlar, activity log: eski → yangi, buyurtma id si.
 */
function buildSvc(existing: any) {
  const svc: any = Object.create(UserServiceService.prototype);
  svc.users = {
    findOne: jest.fn().mockResolvedValue(existing),
    save: jest.fn((u: any) => Promise.resolve(u)),
  };
  svc.syncUserToSearch = jest.fn();
  svc.sanitize = (u: any) => u;
  svc.conflict = (m: string) => {
    throw new Error(m);
  };
  svc.notFound = (m: string) => {
    throw new NotFoundException(m);
  };
  svc.badRequest = (m: string) => {
    throw new BadRequestException(m);
  };
  svc.activityLog = { log: jest.fn(), logChange: jest.fn() };
  return svc;
}

const CUSTOMER = () => ({
  id: '153',
  role: 'customer',
  name: 'Eski Ism',
  phone_number: '+998901112233',
  district_id: '11',
  address: 'Eski manzil',
  extra_number: '90-111-22-33',
  isDeleted: false,
});

describe('txmkXVBa — createCustomer update_existing', () => {
  it('⭐ updateExisting: false — farqli maydonlar bo`lsa ham karta SAQLANMAYDI', async () => {
    const svc = buildSvc(CUSTOMER());
    const res = await svc.createCustomer(
      {
        phone_number: '+998 90 111 22 33',
        name: 'Yangi Ism',
        district_id: '12',
        address: 'Yangi manzil',
        extra_number: '93-000-00-00',
      },
      { updateExisting: false },
    );
    expect(svc.users.save).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      id: '153',
      name: 'Eski Ism',
      address: 'Eski manzil',
    });
  });

  it('sukut (bot / hamkor / import) — avvalgidek patch (j70YS4zJ)', async () => {
    const svc = buildSvc(CUSTOMER());
    await svc.createCustomer({
      phone_number: '+998901112233',
      name: 'Yangi Ism',
      district_id: '11',
    });
    expect(svc.users.save).toHaveBeenCalledTimes(1);
    expect(svc.users.save.mock.calls[0][0].name).toBe('Yangi Ism');
  });
});

describe('txmkXVBa — updateCustomerCard («Kartani ham yangilash»)', () => {
  it('⭐ faqat farq qilgan maydonlar yoziladi, changed_fields va activity log (eski → yangi, buyurtma id)', async () => {
    const svc = buildSvc(CUSTOMER());
    const res = await svc.updateCustomerCard(
      '153',
      {
        name: 'Eski Ism',
        district_id: '12',
        address: 'Yangi manzil',
        extra_number: null,
      },
      { orderId: '9001', marketId: '37' },
    );

    expect(svc.users.findOne).toHaveBeenCalledWith({
      where: { id: '153', role: 'customer', isDeleted: false },
    });
    expect(res.data).toEqual({
      id: '153',
      changed_fields: ['district_id', 'address'],
    });
    const saved = svc.users.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      name: 'Eski Ism',
      district_id: '12',
      address: 'Yangi manzil',
      // null — eski qiymat O'CHIRILMAYDI.
      extra_number: '90-111-22-33',
    });
    expect(svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'User',
        entity_id: '153',
        action: 'updated',
        old_value: { district_id: '11', address: 'Eski manzil' },
        new_value: { district_id: '12', address: 'Yangi manzil' },
        metadata: { source: 'order_create', order_id: '9001', market_id: '37' },
      }),
    );
  });

  it('o`zgarish yo`q — saqlanmaydi, log yo`q, changed_fields bo`sh', async () => {
    const svc = buildSvc(CUSTOMER());
    const res = await svc.updateCustomerCard('153', {
      name: 'Eski Ism',
      address: ' Eski manzil ',
    });
    expect(svc.users.save).not.toHaveBeenCalled();
    expect(svc.activityLog.log).not.toHaveBeenCalled();
    expect(res.data.changed_fields).toEqual([]);
  });

  it('mijoz topilmasa (o`chirilgan / mijoz emas) — 404; noto`g`ri id — 400', async () => {
    await expect(
      buildSvc(null).updateCustomerCard('153', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      buildSvc(CUSTOMER()).updateCustomerCard('1 OR 1=1', { name: 'X' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
