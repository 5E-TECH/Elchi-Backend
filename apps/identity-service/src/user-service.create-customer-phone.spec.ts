/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { RpcException } from '@nestjs/microservices';
import { In } from 'typeorm';
import { normalizeUzPhone, Roles } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * identity.customer.create — telefon NORMALLASHTIRILADI (zfPNDCCr).
 *
 * Bu — Elchi'da mijoz yaratiladigan YAGONA joy: POST /orders,
 * /orders/external, telegram bot, ai-confirm, hamkor (POST
 * /partner/shipments) va tashqi sayt importi hammasi shu RPC'ga keladi.
 *
 * Ilgari mijoz XOM satr bo'yicha qidirilib, XOM satr bilan yozilardi:
 * "998887009150", "+998 88 700 91 50", "887009150" — uchta alohida mijoz
 * (prod E2E: id=160/161/162, "not-a-phone" ham 201). Endi:
 *   - har shakl `+998XXXXXXXXX` ga keltiriladi va shu bilan yoziladi;
 *   - keltirib bo'lmaydigani — 400 (mijoz YARATILMAYDI);
 *   - mavjud mijoz kanonik raqam bo'yicha, topilmasa eski
 *     (normallashtirilmagan) yozuv shakllari bo'yicha topiladi — dublikat
 *     ko'paymaydi.
 */

type Row = Record<string, any>;

function buildSvc(rows: Row[] = []) {
  const svc: any = Object.create(UserServiceService.prototype);
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && '_type' in value) {
        // TypeORM In(...) operatori.
        return (value as { _value: unknown[] })._value.includes(row[key]);
      }
      return row[key] === value;
    });
  svc.users = {
    findOne: jest.fn(async ({ where }: { where: Row }) => {
      const found = rows
        .filter((row) => matches(row, where))
        .sort((a, b) => Number(a.id) - Number(b.id));
      return found[0] ?? null;
    }),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn(async (value: Row) => ({ id: value.id ?? '900', ...value })),
  };
  svc.bcryptEncryption = { encrypt: jest.fn(async () => 'hashed') };
  svc.activityLog = { log: jest.fn(async () => undefined) };
  svc.syncUserToSearch = jest.fn();
  svc.sanitize = (u: Row) => u;
  return svc;
}

const CUSTOMER = (over: Row = {}): Row => ({
  id: '40',
  role: Roles.CUSTOMER,
  name: 'TEST Claude G5 mijoz',
  phone_number: '+998887009150',
  district_id: '173',
  address: null,
  extra_number: null,
  isDeleted: false,
  ...over,
});

const dto = (phone: unknown) => ({
  name: 'TEST Claude G5 mijoz',
  phone_number: phone,
  district_id: '173',
});

const rpcStatus = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return ((error as RpcException).getError() as { statusCode?: number })
      .statusCode;
  }
  throw new Error('xato kutilgan edi');
};

describe('createCustomer — yangi mijoz telefoni kanonik yoziladi (zfPNDCCr)', () => {
  it.each([
    '998887009150',
    '+998 88 700 91 50',
    '88 700 91 50',
    '887009150',
    '0887009150',
  ])("⭐ %p → '+998887009150' bilan yaratiladi", async (phone) => {
    const svc = buildSvc();
    await svc.createCustomer(dto(phone));
    expect(svc.users.create).toHaveBeenCalledTimes(1);
    expect(svc.users.create.mock.calls[0][0].phone_number).toBe(
      '+998887009150',
    );
  });

  it.each(['not-a-phone', '12345', '+1 202 555 0100', '88700915', '', null])(
    '⭐ %p → 400, mijoz yaratilmaydi',
    async (phone) => {
      const svc = buildSvc();
      expect(await rpcStatus(svc.createCustomer(dto(phone)))).toBe(400);
      expect(svc.users.findOne).not.toHaveBeenCalled();
      expect(svc.users.save).not.toHaveBeenCalled();
    },
  );
});

describe('createCustomer — mavjud mijoz bitta (dublikat yo`q) (zfPNDCCr)', () => {
  it.each(['998887009150', '+998 88 700 91 50', '887009150', '0887009150'])(
    "⭐ kanonik mijoz bor: %p → o'sha mijoz (id=40), yangisi yaratilmaydi",
    async (phone) => {
      const svc = buildSvc([CUSTOMER()]);
      const res = await svc.createCustomer(dto(phone));
      expect(res.data.id).toBe('40');
      expect(svc.users.create).not.toHaveBeenCalled();
      expect(svc.users.findOne.mock.calls[0][0].where).toEqual({
        phone_number: '+998887009150',
        isDeleted: false,
      });
    },
  );

  it.each([
    ['900000001', '+998900000001'],
    ['998900000001', '+998 90 000 00 01'],
    ['+998 90 000 00 01', '900000001'],
    ['0900000001', '998900000001'],
  ])(
    "⭐ eski (normallashtirilmagan) mijoz '%s' — '%s' bilan kelsa o'sha topiladi",
    async (stored, incoming) => {
      const svc = buildSvc([CUSTOMER({ id: '160', phone_number: stored })]);
      const res = await svc.createCustomer(dto(incoming));
      expect(res.data.id).toBe('160');
      expect(svc.users.create).not.toHaveBeenCalled();
    },
  );

  it('eski shakl bo`yicha FAQAT mijoz roli izlanadi (xodim qatori qaytmaydi)', async () => {
    const svc = buildSvc([
      CUSTOMER({ id: '7', role: Roles.COURIER, phone_number: '900000001' }),
    ]);
    await svc.createCustomer(dto('+998900000001'));
    const legacyWhere = svc.users.findOne.mock.calls[1][0].where;
    expect(legacyWhere.role).toBe(Roles.CUSTOMER);
    // Xodim qatori mijoz sifatida qaytmadi — yangi kanonik mijoz yaratildi.
    expect(svc.users.create.mock.calls[0][0].phone_number).toBe(
      '+998900000001',
    );
  });

  it('kanonik raqam boshqa rolda band → 409 (avvalgi xulq)', async () => {
    const svc = buildSvc([
      CUSTOMER({ id: '7', role: Roles.COURIER, phone_number: '+998900000001' }),
    ]);
    expect(await rpcStatus(svc.createCustomer(dto('900000001')))).toBe(409);
    expect(svc.users.save).not.toHaveBeenCalled();
  });

  it('eski shakllar ro`yxati: hammasi AYNI kanonik raqamga qaytadi (begona raqam yo`q)', async () => {
    const svc = buildSvc();
    await svc.createCustomer(dto('+998 (90) 000-00-01'));
    const legacyWhere = svc.users.findOne.mock.calls[1][0].where;
    const forms = (legacyWhere.phone_number as ReturnType<typeof In>)
      .value as string[];
    expect(forms).toEqual(
      expect.arrayContaining([
        '998900000001',
        '900000001',
        '0900000001',
        '+998 90 000 00 01',
        '+998 (90) 000-00-01', // kiritilgan xom satr
      ]),
    );
    expect(forms).not.toContain('+998900000001'); // 1-qadamda tekshirilgan
    for (const form of forms) {
      expect(normalizeUzPhone(form)).toBe('+998900000001');
      expect(form.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('searchCustomers — telefon shakli bo`yicha qidiruv (zfPNDCCr)', () => {
  /** Brackets ichidagi where/orWhere chaqiruvlarini yozib oladi. */
  function searchSvc() {
    const clauses: Array<[string, Row | undefined]> = [];
    const inner: Row = {};
    inner.where = (sql: string, params?: Row) => {
      clauses.push([sql, params]);
      return inner;
    };
    inner.orWhere = inner.where;
    const qb: Row = {};
    Object.assign(qb, {
      where: () => qb,
      andWhere: (arg: unknown) => {
        const factory = (arg as { whereFactory?: (q: Row) => void })
          ?.whereFactory;
        if (factory) factory(inner);
        return qb;
      },
      orderBy: () => qb,
      take: () => qb,
      getMany: async () => [],
    });
    const svc: any = Object.create(UserServiceService.prototype);
    svc.users = { createQueryBuilder: () => qb };
    svc.sanitize = (u: Row) => u;
    return { svc, clauses };
  }

  it.each(['0901234567', '+998 90 123 45 67', '998901234567'])(
    "⭐ %p → milliy '901234567' bo'yicha ham izlanadi",
    async (search) => {
      const { svc, clauses } = searchSvc();
      await svc.searchCustomers(search);
      expect(clauses).toContainEqual([
        'u.phone_number LIKE :national',
        { national: '%901234567%' },
      ]);
    },
  );

  it("ism qidiruvi ('Ali') — telefon bandi qo'shilmaydi", async () => {
    const { svc, clauses } = searchSvc();
    await svc.searchCustomers('Ali');
    expect(clauses.map(([sql]) => sql)).toEqual([
      'u.name ILIKE :s',
      'u.phone_number ILIKE :s',
    ]);
  });
});
