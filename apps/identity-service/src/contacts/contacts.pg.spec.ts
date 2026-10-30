import { RpcException } from '@nestjs/microservices';
import { DataSource, Repository } from 'typeorm';
import { of } from 'rxjs';
import { Roles, Status } from '@app/common';
import { User } from '../entities/user.entity';
import { CourierRegion } from '../entities/courier-region.entity';
import { AppSetting } from '../entities/app-setting.entity';
import { UserServiceService } from '../user-service.service';
import { ContactsService } from './contacts.service';
import { MarketResponsibleContacts1716000000185 } from '../../../../migrations/1716000000185-MarketResponsibleContacts';

/**
 * T7 (QPq2C1co) «Aloqa raqamlari» — identity, haqiqiy Postgres.
 *
 * Ishga tushirish (alohida lokal `_test` bazasi — sxemani tozalaydi):
 *   IDENTITY_CONTACTS_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_contacts_test
 */
const uri = process.env.IDENTITY_CONTACTS_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();
const maybe = localTestDatabase ? describe : describe.skip;

async function rpcError(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      code?: string;
    };
  }
  throw new Error('RpcException kutilgandi');
}

const SA = { id: '1', roles: ['superadmin'] };

maybe('T7 — 1716000000185 migratsiyasi (up/down)', () => {
  let db: DataSource;

  beforeAll(async () => {
    db = new DataSource({ type: 'postgres', url: uri, entities: [] });
    await db.initialize();
    await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
    await db.query('CREATE SCHEMA identity_schema');
    await db.query(
      'CREATE TABLE identity_schema.admins (id BIGSERIAL PRIMARY KEY, name varchar(100))',
    );
    await db.query(`INSERT INTO identity_schema.admins (name) VALUES ('m1')`);
  });

  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      await db.destroy();
    }
  });

  it('up: ustun NULL, app_settings bo`sh kalitlar bilan; qayta up xatosiz; down tozalaydi', async () => {
    const migration = new MarketResponsibleContacts1716000000185();
    const qr = db.createQueryRunner();
    await migration.up(qr);
    await migration.up(qr);

    const [admin] = await db.query(
      'SELECT market_responsible_id FROM identity_schema.admins LIMIT 1',
    );
    expect(admin).toEqual({ market_responsible_id: null });
    const settings = await db.query(
      'SELECT key, value FROM identity_schema.app_settings ORDER BY key',
    );
    expect(settings).toEqual([
      { key: 'contacts.default_market_responsible_id', value: null },
      { key: 'contacts.support_phones', value: [] },
    ]);
    await expect(
      db.query(
        `INSERT INTO identity_schema.app_settings (key, value) VALUES ('contacts.support_phones', '[]')`,
      ),
    ).rejects.toThrow(/UQ_APP_SETTINGS_KEY|duplicate/);

    await migration.down(qr);
    const [tbl] = await db.query(
      `SELECT to_regclass('identity_schema.app_settings') AS t`,
    );
    expect(tbl.t).toBeNull();
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'identity_schema' AND table_name = 'admins'`,
    );
    expect(
      cols.map((c: { column_name: string }) => c.column_name),
    ).not.toContain('market_responsible_id');
    await qr.release();
  });
});

maybe('T7 — market mas`uli, sozlamalar, aloqa rezolverlari (Postgres)', () => {
  let db: DataSource;
  let users: Repository<User>;
  let contacts: ContactsService;
  let userService: UserServiceService;
  const activityLog = { log: jest.fn(), logChange: jest.fn() };
  /** logistics: viloyat 1 — logist bor, 2 — logistsiz; tuman 10 → 1 (assigned), 20 → 2. */
  let regions: Array<{ id: string; name: string; logist_id: string | null }> =
    [];
  const logistics = {
    send: jest.fn((pattern: { cmd: string }, payload: { ids?: string[] }) => {
      if (pattern.cmd === 'logistics.region.find_by_ids') {
        return of({
          data: regions.filter((r) => (payload.ids ?? []).includes(r.id)),
        });
      }
      if (pattern.cmd === 'logistics.district.find_by_ids') {
        const districts = [
          { id: '10', region_id: '9', assigned_region: '1' },
          { id: '20', region_id: '2', assigned_region: null },
        ];
        return of({
          data: districts.filter((d) => (payload.ids ?? []).includes(d.id)),
        });
      }
      return of({ data: null });
    }),
    emit: jest.fn(),
  };
  let branchRegion: string | null = null;
  const branch = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'branch.user.find_by_user'
        ? of({
            data: branchRegion
              ? { branch_id: '3', branch: { id: '3', region_id: branchRegion } }
              : null,
          })
        : of({ data: null }),
    ),
    emit: jest.fn(),
  };

  let seq = 0;
  const addUser = async (role: Roles, over: Partial<User> = {}) => {
    seq += 1;
    const res = await users.insert({
      name: `${role}-${seq}`,
      phone_number: `+99890${String(1000000 + seq).slice(-7)}`,
      username: `${role}${seq}`,
      password: 'x',
      role,
      status: Status.ACTIVE,
      ...over,
    } as never);
    return String(res.identifiers[0].id);
  };
  const responsibleOf = async (id: string) =>
    (
      await db.query(
        'SELECT market_responsible_id FROM identity_schema.admins WHERE id = $1',
        [id],
      )
    )[0].market_responsible_id as string | null;

  beforeAll(async () => {
    db = new DataSource({
      type: 'postgres',
      url: uri,
      entities: [User, CourierRegion, AppSetting],
      synchronize: false,
    });
    await db.initialize();
    await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
    await db.query('CREATE SCHEMA identity_schema');
    await db.synchronize();
    await new MarketResponsibleContacts1716000000185().up(
      db.createQueryRunner(),
    );
    users = db.getRepository(User);
    contacts = new ContactsService(
      users,
      db.getRepository(AppSetting),
      db.getRepository(CourierRegion),
      logistics as never,
      branch as never,
      activityLog as never,
    );
    const noop = { send: jest.fn(() => of({})), emit: jest.fn() };
    userService = new UserServiceService(
      users,
      noop as never, // search
      noop as never, // catalog
      noop as never, // order
      logistics as never,
      noop as never, // finance
      branch as never,
      { encrypt: jest.fn(), compare: jest.fn() } as never,
      { get: jest.fn() } as never,
      activityLog as never,
      undefined,
      contacts,
    );
  });

  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      await db.destroy();
    }
  });

  beforeEach(async () => {
    activityLog.log.mockClear();
    regions = [];
    branchRegion = null;
    await db.query(
      `UPDATE identity_schema.app_settings SET value = CASE key
         WHEN 'contacts.support_phones' THEN '[]'::jsonb ELSE 'null'::jsonb END,
         updated_by = NULL`,
    );
  });

  describe('sozlamalar', () => {
    it('PATCH: telefon normallanadi; GET shakli; jurnal settings.contacts_updated', async () => {
      const responsible = await addUser(Roles.REGISTRATOR);
      const res: any = await contacts.updateSettings(
        {
          support_phones: ['71 200 11 22'],
          default_market_responsible_id: responsible,
        },
        SA,
      );
      expect(res.data).toEqual(
        expect.objectContaining({
          support_phones: ['+998712001122'],
          default_market_responsible: expect.objectContaining({
            id: responsible,
            role: 'registrator',
            status: 'active',
          }),
          updated_by: '1',
        }),
      );
      expect(typeof res.data.updated_at).toBe('string');
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'settings.contacts_updated',
          old_value: {
            support_phones: [],
            default_market_responsible_id: null,
          },
          new_value: {
            support_phones: ['+998712001122'],
            default_market_responsible_id: responsible,
          },
        }),
      );
      const get: any = await contacts.getSettings(SA);
      expect(get.data.support_phones).toEqual(['+998712001122']);
    });

    it('⭐ QM6: ["123"] yoki 3 ta → 400 SUPPORT_PHONES_INVALID; bo`sh tana 400; kuryer → RESPONSIBLE_ROLE_INVALID', async () => {
      expect(
        await rpcError(
          contacts.updateSettings({ support_phones: ['123'] }, SA),
        ),
      ).toEqual(
        expect.objectContaining({
          statusCode: 400,
          code: 'SUPPORT_PHONES_INVALID',
        }),
      );
      expect(
        await rpcError(
          contacts.updateSettings(
            {
              support_phones: [
                '+998901112233',
                '+998901112234',
                '+998901112235',
              ],
            },
            SA,
          ),
        ),
      ).toEqual(expect.objectContaining({ code: 'SUPPORT_PHONES_INVALID' }));
      expect(await rpcError(contacts.updateSettings({}, SA))).toEqual(
        expect.objectContaining({ statusCode: 400 }),
      );
      const courier = await addUser(Roles.COURIER);
      expect(
        await rpcError(
          contacts.updateSettings(
            { default_market_responsible_id: courier },
            SA,
          ),
        ),
      ).toEqual(
        expect.objectContaining({
          statusCode: 400,
          code: 'RESPONSIBLE_ROLE_INVALID',
        }),
      );
      const inactive = await addUser(Roles.ADMIN, { status: Status.INACTIVE });
      expect(
        await rpcError(
          contacts.updateSettings(
            { default_market_responsible_id: inactive },
            SA,
          ),
        ),
      ).toEqual(
        expect.objectContaining({
          statusCode: 400,
          code: 'RESPONSIBLE_INACTIVE',
        }),
      );
      expect(
        await rpcError(
          contacts.updateSettings(
            { default_market_responsible_id: '999999' },
            SA,
          ),
        ),
      ).toEqual(expect.objectContaining({ statusCode: 404 }));
    });

    it('⭐ QM5: registrator / menejer → 403 (identity ham tekshiradi)', async () => {
      expect(
        await rpcError(
          contacts.getSettings({ id: '5', roles: ['registrator'] }),
        ),
      ).toEqual(expect.objectContaining({ statusCode: 403 }));
      expect(
        await rpcError(
          contacts.assignOne('1', null, { id: '5', roles: ['manager'] }),
        ),
      ).toEqual(expect.objectContaining({ statusCode: 403 }));
    });
  });

  describe("mas'ul biriktirish", () => {
    it('⭐ QM8: 3 market (2 tasi X da) → Y: moved_from [{X, 2}], jurnalda market.responsible_assigned', async () => {
      const x = await addUser(Roles.ADMIN);
      const y = await addUser(Roles.LOGIST);
      const m1 = await addUser(Roles.MARKET, { market_responsible_id: x });
      const m2 = await addUser(Roles.MARKET, { market_responsible_id: x });
      const m3 = await addUser(Roles.MARKET);
      const untouched = await addUser(Roles.MARKET, {
        market_responsible_id: x,
      });

      const res: any = await contacts.bulkAssign(
        { responsible_id: y, market_ids: [m1, m2, m3] },
        SA,
      );
      expect(res.data).toEqual({
        updated: 3,
        moved_from: [{ responsible_id: x, count: 2 }],
      });
      for (const id of [m1, m2, m3]) {
        expect(await responsibleOf(id)).toBe(y);
      }
      expect(await responsibleOf(untouched)).toBe(x);
      expect(activityLog.log).toHaveBeenCalledTimes(3);
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'market.responsible_assigned',
          entity_id: m1,
          old_value: { market_responsible_id: x },
          new_value: { market_responsible_id: y },
        }),
      );

      // Sukutga qaytarish — null.
      const back: any = await contacts.bulkAssign(
        { responsible_id: null, market_ids: [m1] },
        SA,
      );
      expect(back.data).toEqual({
        updated: 1,
        moved_from: [{ responsible_id: y, count: 1 }],
      });
      expect(await responsibleOf(m1)).toBeNull();
    });

    it('market bo`lmagan id → 400 NOT_A_MARKET, hech narsa o`zgarmaydi', async () => {
      const y = await addUser(Roles.ADMIN);
      const market = await addUser(Roles.MARKET);
      const courier = await addUser(Roles.COURIER);
      expect(
        await rpcError(
          contacts.bulkAssign(
            { responsible_id: y, market_ids: [market, courier] },
            SA,
          ),
        ),
      ).toEqual(
        expect.objectContaining({ statusCode: 400, code: 'NOT_A_MARKET' }),
      );
      expect(await responsibleOf(market)).toBeNull();
    });

    it('PATCH /markets/:id/responsible → { id, responsible, responsible_source }; nofaol — sukutga o`tadi', async () => {
      const def = await addUser(Roles.ADMIN);
      const x = await addUser(Roles.REGISTRATOR);
      await contacts.updateSettings({ default_market_responsible_id: def }, SA);
      const market = await addUser(Roles.MARKET);

      const res: any = await contacts.assignOne(market, x, SA);
      expect(res.data).toEqual({
        id: market,
        responsible: expect.objectContaining({ id: x, role: 'registrator' }),
        responsible_source: 'assigned',
      });

      // Nofaol mas'ul: biriktiruv QOLADI, hisobda sukut.
      await users.update({ id: x }, { status: Status.INACTIVE });
      const views = await contacts.resolveMarketResponsibles([
        { id: market, market_responsible_id: x },
      ]);
      expect(views.get(market)).toEqual({
        responsible: expect.objectContaining({ id: def }),
        responsible_source: 'default',
      });
      expect(await responsibleOf(market)).toBe(x);

      // Sukut ham nofaol — none.
      await users.update({ id: def }, { status: Status.INACTIVE });
      const none = await contacts.resolveMarketResponsibles([
        { id: market, market_responsible_id: x },
      ]);
      expect(none.get(market)).toEqual({
        responsible: null,
        responsible_source: 'none',
      });
    });

    it('GET /markets/responsibles: market_count va default_market_count', async () => {
      const x = await addUser(Roles.ADMIN, { name: 'Zebo Count' });
      await addUser(Roles.MARKET, { market_responsible_id: x });
      await addUser(Roles.MARKET, { market_responsible_id: x });
      const res: any = await contacts.listResponsibles('Zebo', SA);
      expect(res.data.candidates).toEqual([
        expect.objectContaining({ id: x, market_count: 2, status: 'active' }),
      ]);
      const [{ count }] = await db.query(
        `SELECT COUNT(*)::int AS count FROM identity_schema.admins
          WHERE role = 'market' AND is_deleted = false AND market_responsible_id IS NULL`,
      );
      expect(res.data.default_market_count).toBe(count);
      // Mas'ul bo'lmaydigan rollar ro'yxatda yo'q.
      const courier = await addUser(Roles.COURIER, { name: 'Zebo Kuryer' });
      const again: any = await contacts.listResponsibles('Zebo', SA);
      expect(
        again.data.candidates.map((c: { id: string }) => c.id),
      ).not.toContain(courier);
    });

    it('GET /markets: ?responsible_id=<id>|none filtri va responsible maydoni', async () => {
      const x = await addUser(Roles.LOGIST);
      const assigned = await addUser(Roles.MARKET, {
        market_responsible_id: x,
      });
      const byX: any = await userService.findAllMarkets({
        responsible_id: x,
        limit: 100,
      });
      expect(byX.data.items.map((m: { id: string }) => m.id)).toEqual([
        assigned,
      ]);
      expect(byX.data.items[0]).toEqual(
        expect.objectContaining({
          responsible: expect.objectContaining({ id: x, role: 'logist' }),
          responsible_source: 'assigned',
        }),
      );
      const none: any = await userService.findAllMarkets({
        responsible_id: 'none',
        limit: 100,
      });
      expect(none.data.items.map((m: { id: string }) => m.id)).not.toContain(
        assigned,
      );
      expect(
        none.data.items.every(
          (m: { market_responsible_id: string | null }) =>
            m.market_responsible_id === null,
        ),
      ).toBe(true);

      // GET /users/:id (market) — mas'ul ham.
      const one: any = await userService.findUserById(assigned, {
        includeBranch: true,
      });
      expect(one.data.responsible_source).toBe('assigned');
    });
  });

  describe('B4 — mas`ul o`chirilsa yoki roli o`zgarsa', () => {
    it('⭐ QM7: 5 market mas`uli o`chirilsa → hammasi sukutga, sukut ham null, market_count 0', async () => {
      const x = await addUser(Roles.REGISTRATOR);
      const markets: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        markets.push(await addUser(Roles.MARKET, { market_responsible_id: x }));
      }
      await contacts.updateSettings({ default_market_responsible_id: x }, SA);

      await userService.deleteUser(x, SA);

      for (const id of markets) {
        expect(await responsibleOf(id)).toBeNull();
      }
      const settings: any = await contacts.getSettings(SA);
      expect(settings.data.default_market_responsible).toBeNull();
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'market.responsible_assigned',
          entity_id: x,
          metadata: expect.objectContaining({
            reason: 'responsible_deleted',
            market_count: 5,
          }),
        }),
      );
    });

    it('⭐ QM7: roli menejerga o`zgarsa → marketlar sukutga; admin → logist — qoladi', async () => {
      const x = await addUser(Roles.ADMIN);
      const market = await addUser(Roles.MARKET, { market_responsible_id: x });

      await userService.changeUserRole(x, Roles.LOGIST, SA);
      expect(await responsibleOf(market)).toBe(x);

      await userService.changeUserRole(x, Roles.MANAGER, SA);
      expect(await responsibleOf(market)).toBeNull();
      const list: any = await contacts.listResponsibles('', SA);
      expect(
        list.data.candidates.map((c: { id: string }) => c.id),
      ).not.toContain(x);
    });

    it('nofaol qilish biriktiruvni o`chirmaydi', async () => {
      const x = await addUser(Roles.ADMIN);
      const market = await addUser(Roles.MARKET, { market_responsible_id: x });
      await userService.setUserStatus(x, Status.INACTIVE, SA);
      expect(await responsibleOf(market)).toBe(x);
    });
  });

  describe('GET /users/me/contacts', () => {
    it('⭐ QM4: kuryer → region_logist, assigned, logist raqami; admin → none', async () => {
      const logist = await addUser(Roles.LOGIST, {
        phone_number: '+998901112233',
      });
      regions = [{ id: '1', name: 'Andijon viloyati', logist_id: logist }];
      const courier = await addUser(Roles.COURIER, { region_id: '1' });

      const res: any = await contacts.myContacts(courier);
      expect(res.data).toEqual({
        kind: 'region_logist',
        source: 'assigned',
        regions: [{ id: '1', name: 'Andijon viloyati' }],
        contacts: [
          {
            user_id: logist,
            name: expect.any(String),
            phone: '+998901112233',
            role: 'logist',
          },
        ],
      });

      const admin = await addUser(Roles.ADMIN);
      expect(((await contacts.myContacts(admin)) as any).data).toEqual({
        kind: 'none',
        source: null,
        regions: [],
        contacts: [],
      });
    });

    it('logist nofaol → zaxira (user_id/name/role null); zaxira bo`sh → contacts: []', async () => {
      const logist = await addUser(Roles.LOGIST, { status: Status.INACTIVE });
      regions = [{ id: '2', name: 'Namangan', logist_id: logist }];
      const courier = await addUser(Roles.COURIER, { region_id: '2' });
      expect(((await contacts.myContacts(courier)) as any).data).toEqual({
        kind: 'region_logist',
        source: null,
        regions: [{ id: '2', name: 'Namangan' }],
        contacts: [],
      });
      await contacts.updateSettings({ support_phones: ['+998712001122'] }, SA);
      expect(((await contacts.myContacts(courier)) as any).data).toEqual(
        expect.objectContaining({
          source: 'support',
          contacts: [
            { user_id: null, name: null, phone: '+998712001122', role: null },
          ],
        }),
      );
    });

    it('menejer — filial viloyati logisti; market va operator — o`z mas`uli', async () => {
      const logist = await addUser(Roles.LOGIST);
      regions = [{ id: '1', name: 'Andijon', logist_id: logist }];
      branchRegion = '1';
      const manager = await addUser(Roles.MANAGER);
      expect(
        ((await contacts.myContacts(manager)) as any).data.contacts[0].user_id,
      ).toBe(logist);

      const responsible = await addUser(Roles.REGISTRATOR);
      const market = await addUser(Roles.MARKET, {
        market_responsible_id: responsible,
      });
      const operator = await addUser(Roles.MARKET_OPERATOR, {
        market_id: market,
      });
      for (const id of [market, operator]) {
        const data = ((await contacts.myContacts(id)) as any).data;
        expect(data).toEqual(
          expect.objectContaining({
            kind: 'market_responsible',
            source: 'assigned',
            contacts: [expect.objectContaining({ user_id: responsible })],
          }),
        );
      }
    });

    it('super kuryer — courier_regions logistlari; serves_all_regions — zaxira', async () => {
      const l1 = await addUser(Roles.LOGIST);
      const l2 = await addUser(Roles.LOGIST);
      regions = [
        { id: '5', name: 'A', logist_id: l1 },
        { id: '6', name: 'B', logist_id: l2 },
      ];
      const sc = await addUser(Roles.COURIER, {
        region_id: '5',
        is_super_courier: true,
      });
      await db.getRepository(CourierRegion).insert([
        { courier_id: sc, region_id: '5' },
        { courier_id: sc, region_id: '6' },
      ] as never);
      const data = ((await contacts.myContacts(sc)) as any).data;
      expect(data.contacts.map((c: { user_id: string }) => c.user_id)).toEqual([
        l1,
        l2,
      ]);
      await users.update({ id: sc }, { serves_all_regions: true });
      await contacts.updateSettings({ support_phones: ['+998712001122'] }, SA);
      expect(((await contacts.myContacts(sc)) as any).data.source).toBe(
        'support',
      );
    });
  });

  describe('problem_contacts', () => {
    it('⭐ QM1/QM2: logist → o`zi; logistsiz — zaxira; tuman → assigned_region; zaxira bo`sh → []', async () => {
      const logist = await addUser(Roles.LOGIST, {
        phone_number: '+998901112299',
      });
      regions = [
        { id: '1', name: 'Andijon', logist_id: logist },
        { id: '2', name: 'Namangan', logist_id: null },
      ];
      const empty: any = await contacts.problemContacts({
        region_ids: ['1', '2'],
        district_ids: ['10', '20'],
      });
      expect(empty.data).toEqual({
        regions: {
          '1': [
            {
              name: expect.any(String),
              phone: '+998901112299',
              source: 'logist',
            },
          ],
          '2': [],
        },
        districts: {
          '10': [
            {
              name: expect.any(String),
              phone: '+998901112299',
              source: 'logist',
            },
          ],
          '20': [],
        },
        fallback: [],
      });

      await contacts.updateSettings({ support_phones: ['+998712001122'] }, SA);
      const withSupport: any = await contacts.problemContacts({
        region_ids: ['2'],
      });
      expect(withSupport.data.regions['2']).toEqual([
        { name: null, phone: '+998712001122', source: 'support' },
      ]);
      expect(withSupport.data.fallback).toEqual([
        { name: null, phone: '+998712001122', source: 'support' },
      ]);
    });
  });
});
