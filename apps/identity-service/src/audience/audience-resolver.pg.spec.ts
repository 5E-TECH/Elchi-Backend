import { DataSource } from 'typeorm';
import { Roles } from '@app/common';
import { User } from '../entities/user.entity';
import { resolveAudience } from './audience-resolver';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

/**
 * (W8aerwL6) Haqiqiy Postgres'da auditoriya SQL'i: superadmin va mijoz
 * chiqadi (TC2), segment faqat o'sha mijozlarni beradi (TC5), 250 mijoz
 * sahifalab to'liq yig'iladi (TC12), `language` bor (TC11).
 *
 * Ishga tushirish (lokal klaster, prod EMAS):
 *   IDENTITY_AUDIENCE_PG_TEST_URI=postgres://postgres@127.0.0.1:55444/elchi_audience_test
 */
const uri = process.env.IDENTITY_AUDIENCE_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_audience_test'
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'W8aerwL6 — identity.audience.resolve (Postgres)',
  () => {
    let db: DataSource;
    const orderClient = {} as never;

    const insertUsers = async (
      rows: Array<{
        role: Roles;
        name: string;
        phone: string;
        language?: string;
        settings?: Record<string, unknown> | null;
        isDeleted?: boolean;
      }>,
    ) => {
      const repo = db.getRepository(User);
      const saved = await repo.save(
        rows.map((row) =>
          repo.create({
            name: row.name,
            phone_number: row.phone,
            password: 'x',
            role: row.role,
            language: row.language ?? 'uz',
            settings: row.settings ?? null,
            isDeleted: row.isDeleted ?? false,
          }),
        ),
      );
      return saved.map((user) => String(user.id));
    };

    let superadminId: string;
    let courierId: string;
    let deletedCourierId: string;
    let customerIds: string[];

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'identity_schema',
        entities: [User],
        synchronize: false,
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS "identity_schema" CASCADE');
      await db.query('CREATE SCHEMA "identity_schema"');
      await db.synchronize();

      [superadminId, courierId, deletedCourierId] = await insertUsers([
        { role: Roles.SUPERADMIN, name: 'Boss', phone: '+998900000001' },
        {
          role: Roles.COURIER,
          name: 'Kuryer',
          phone: '+998900000002',
          language: 'uz',
          settings: { appearance: { language: 'ru' } },
        },
        {
          role: Roles.COURIER,
          name: "O'chgan",
          phone: '+998900000003',
          isDeleted: true,
        },
        { role: Roles.ADMIN, name: 'Admin', phone: '998900000004' },
      ]);
      customerIds = await insertUsers(
        Array.from({ length: 250 }, (_, i) => ({
          role: Roles.CUSTOMER,
          name: `Mijoz ${i + 1}`,
          phone: `+99891${String(i + 1).padStart(7, '0')}`,
          language: i % 2 ? 'ru' : 'uz',
        })),
      );
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS "identity_schema" CASCADE');
        await db.destroy();
      }
    });

    beforeEach(() => rmqSendMock.mockReset());

    const run = (input: Record<string, unknown>) =>
      resolveAudience(db.getRepository(User), orderClient, input);

    it('TC2: roles:[superadmin] — superadmin qaytadi (findAllAdmins filtri bu yerda yo‘q)', async () => {
      const res = await run({ roles: ['superadmin'] });
      expect(res.data.total).toBe(1);
      expect(res.data.items).toEqual([
        expect.objectContaining({
          id: superadminId,
          role: 'superadmin',
          name: 'Boss',
          phone: '+998900000001',
        }),
      ]);
    });

    it('TC2/TC4: roles:[customer] + include_customers + confirm — mijozlar qaytadi, o‘chirilganlar yo‘q', async () => {
      const res = await run({
        roles: ['customer'],
        include_customers: true,
        confirm_all_customers: true,
        limit: 10,
      });
      expect(res.data.total).toBe(250);
      expect(res.data.items).toHaveLength(10);
      expect(res.data.items.every((i: any) => i.role === 'customer')).toBe(
        true,
      );
    });

    it('broadcast — barcha xodimlar (superadmin ham), mijozsiz; o‘chirilgan kuryer yo‘q', async () => {
      const res = await run({ broadcast: true, limit: 100 });
      const ids = res.data.items.map((i: any) => i.id);
      expect(ids).toContain(superadminId);
      expect(ids).toContain(courierId);
      expect(ids).not.toContain(deletedCourierId);
      expect(res.data.items.some((i: any) => i.role === 'customer')).toBe(
        false,
      );
      expect(res.data.total).toBe(3);
    });

    it('TC5: segment (hudud) — faqat order-service bergan mijozlar; xodim rollari segmentga tushmaydi', async () => {
      const inRegion = customerIds.slice(0, 3);
      rmqSendMock.mockResolvedValueOnce({
        data: {
          items: [...inRegion, courierId].map((customer_id) => ({
            customer_id,
          })),
          truncated: false,
        },
      });
      const res = await run({
        include_customers: true,
        segment: { region_id: '7' },
      });
      expect(rmqSendMock).toHaveBeenCalledWith(
        orderClient,
        { cmd: 'order.customer.segment' },
        { region_id: '7', limit: 5000 },
      );
      // kuryer id'si segment ro'yxatida bo'lsa ham — u mijoz emas
      expect(res.data.items.map((i: any) => i.id)).toEqual(inRegion);
      expect(res.data.total).toBe(3);
    });

    it('TC12: 250 mijozli segment sahifalab TO‘LIQ yig‘iladi (keyset, birinchi sahifada to‘xtamaydi)', async () => {
      rmqSendMock.mockResolvedValue({
        data: {
          items: customerIds.map((customer_id) => ({ customer_id })),
          truncated: false,
        },
      });
      const seen: string[] = [];
      let after: string | null = null;
      let calls = 0;
      do {
        const res: any = await run({
          include_customers: true,
          segment: { min_orders: 1 },
          limit: 100,
          after_id: after,
          fields: 'minimal',
          with_total: false,
        });
        calls += 1;
        seen.push(...res.data.items.map((i: any) => i.id));
        // minimal — telefon/ism umuman yo'q
        res.data.items.forEach((i: any) => {
          expect(i).not.toHaveProperty('phone');
          expect(i).not.toHaveProperty('name');
        });
        after = res.data.next_after_id;
      } while (after);
      expect(calls).toBe(3);
      expect(seen).toEqual(customerIds);
      expect(new Set(seen).size).toBe(250);
    });

    it('TC12: page/limit sahifalash ham to‘liq (3 sahifa)', async () => {
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const res: any = await run({
          include_customers: true,
          confirm_all_customers: true,
          page,
          limit: 100,
        });
        expect(res.data.total).toBe(250);
        seen.push(...res.data.items.map((i: any) => i.id));
      }
      expect(seen).toEqual(customerIds);
    });

    it('TC11: language — mijoz ustundan, xodim settings.appearance.language dan', async () => {
      const res = await run({
        roles: ['courier', 'customer'],
        include_customers: true,
        confirm_all_customers: true,
        limit: 3,
      });
      const byId = new Map(res.data.items.map((i: any) => [i.id, i]));
      expect((byId.get(courierId) as any).language).toBe('ru');
      expect(res.data.items.every((i: any) => 'language' in i)).toBe(true);
      const customers = res.data.items.filter(
        (i: any) => i.role === 'customer',
      );
      expect(customers[0].language).toBe('uz');
      expect(customers[1].language).toBe('ru');
    });

    it('with_stats — rollar kesimi va yaroqli (+998XXXXXXXXX) telefonlar', async () => {
      const res = await run({
        broadcast: true,
        include_customers: true,
        confirm_all_customers: true,
        with_stats: true,
        limit: 1,
      });
      expect(res.data.total).toBe(253);
      expect(res.data.stats.by_role).toEqual({
        superadmin: 1,
        courier: 1,
        admin: 1,
        customer: 250,
      });
      // admin telefoni '998...' (kanonik emas) — SMS'ga yaroqsiz
      expect(res.data.stats.with_valid_phone).toBe(252);
    });

    it('phone_valid — har elementda bayroq (raqamning o‘zi minimal da yo‘q)', async () => {
      const res = await run({
        roles: ['admin', 'superadmin'],
        fields: 'minimal',
      });
      expect(res.data.items.map((i: any) => [i.role, i.phone_valid])).toEqual([
        ['superadmin', true],
        ['admin', false],
      ]);
    });
  },
);
