import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { attachUserActivity } from './user-activity-view';
import { ROLES_KEY } from './auth/roles.decorator';

/**
 * (pe71yf8L) `GET /users` va `GET /users/:id` — market va market operatori
 * qatorlarida «Oxirgi kirish» (`last_login_at`), «Oxirgi faollik»
 * (`last_seen_at`) va «Online» (`is_online`). Xodim qatorlarida maydon
 * yo'q. Identity faollik so'rovi yiqilsa ro'yxat baribir ochiladi.
 */
type Row = Record<string, unknown>;
type Pattern = { cmd: string };

const SUPERADMIN = {
  user: { sub: '1', username: 'sa', roles: ['superadmin'] },
};
const MANAGER = { user: { sub: '520', username: 'mgr', roles: ['manager'] } };

const ACTIVITY = {
  items: [
    {
      user_id: '26',
      last_login_at: '2026-11-27T08:00:00.000Z',
      last_seen_at: '2026-11-27T08:30:00.000Z',
    },
    {
      user_id: '41',
      last_login_at: '2026-11-20T10:00:00.000Z',
      last_seen_at: '2026-11-20T11:00:00.000Z',
    },
  ],
};

describe('pe71yf8L — GET /users: market faolligi', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let activityReply: () => unknown;
  const online = new Set<string>(['26']);

  const listRows: Row[] = [
    { id: '26', role: 'market', name: 'TEST market' },
    { id: '27', role: 'market', name: 'Hech kirmagan market' },
    { id: '41', role: 'market_operator', name: 'TEST operator' },
    { id: '25', role: 'courier', name: 'TEST kuryer' },
  ];

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    activityReply = () => of(ACTIVITY);
    identityClient = {
      send: jest.fn((pattern: Pattern, payload: Row) => {
        if (pattern.cmd === 'identity.user.find_all') {
          return of({
            statusCode: 200,
            data: {
              items: listRows.map((row) => ({ ...row })),
              meta: { page: 1, limit: 10, total: 4 },
            },
          });
        }
        if (pattern.cmd === 'identity.user.find_by_id') {
          const found = listRows.find((row) => row.id === String(payload.id));
          return of({ statusCode: 200, data: found ? { ...found } : null });
        }
        if (pattern.cmd === 'identity.user.activity.find_by_ids') {
          return activityReply();
        }
        return of({ data: [] });
      }),
    };
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: identityClient },
        { provide: 'FINANCE', useValue: { send: jest.fn() } },
        {
          provide: 'BRANCH',
          useValue: { send: jest.fn(() => of({ data: [] })) },
        },
        {
          provide: RealtimeGateway,
          useValue: { isPresent: (id: string) => online.has(String(id)) },
        },
      ],
    }).compile();
    controller = app.get(ApiGatewayController);
  });

  afterEach(() => jest.restoreAllMocks());

  const listUsers = (req: Row, role?: string) =>
    controller.getUsers(
      undefined,
      role,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      req as never,
    ) as Promise<{ data: { items: Row[] } }>;

  const activityCalls = () =>
    identityClient.send.mock.calls.filter(
      ([pattern]) =>
        (pattern as Pattern).cmd === 'identity.user.activity.find_by_ids',
    );

  it('⭐ TC1/TC4/TC8: market va operator qatorlari — is_online + oxirgi kirish/faollik; hech kirmagan — null', async () => {
    const res = await listUsers(SUPERADMIN, 'market');
    const byId = new Map(res.data.items.map((row) => [row.id, row]));

    expect(byId.get('26')).toMatchObject({
      is_online: true,
      last_login_at: '2026-11-27T08:00:00.000Z',
      last_seen_at: '2026-11-27T08:30:00.000Z',
    });
    expect(byId.get('27')).toMatchObject({
      is_online: false,
      last_login_at: null,
      last_seen_at: null,
    });
    // Operator — O'Z akkaunti, market qatoriga qo'shilmaydi.
    expect(byId.get('41')).toMatchObject({
      is_online: false,
      last_login_at: '2026-11-20T10:00:00.000Z',
    });
    // Bitta so'rov, faqat market tomonidagi id'lar.
    expect(activityCalls()).toHaveLength(1);
    expect(activityCalls()[0][1]).toEqual({ user_ids: ['26', '27', '41'] });
  });

  it('⭐ TC9: xodim (kuryer) qatorida faollik maydonlari yo`q', async () => {
    const res = await listUsers(SUPERADMIN);
    const courier = res.data.items.find((row) => row.id === '25')!;
    expect(courier).not.toHaveProperty('is_online');
    expect(courier).not.toHaveProperty('last_login_at');
    expect(courier).not.toHaveProperty('last_seen_at');
  });

  it('identity faollik so`rovi yiqilsa — ro`yxat ochiladi, is_online bor, last_* yo`q', async () => {
    activityReply = () => throwError(() => new Error('identity timeout'));
    const res = await listUsers(SUPERADMIN, 'market');
    const market = res.data.items.find((row) => row.id === '26')!;
    expect(market.is_online).toBe(true);
    expect(market).not.toHaveProperty('last_login_at');
    expect(res.data.items).toHaveLength(4);
  });

  it('faqat xodimlar sahifasi — identity`ga faollik so`rovi ketmaydi', async () => {
    listRows.splice(0, 3);
    try {
      await listUsers(SUPERADMIN, 'courier');
      expect(activityCalls()).toHaveLength(0);
    } finally {
      listRows.unshift(
        { id: '26', role: 'market', name: 'TEST market' },
        { id: '27', role: 'market', name: 'Hech kirmagan market' },
        { id: '41', role: 'market_operator', name: 'TEST operator' },
      );
    }
  });

  it('⭐ TC1: GET /users/:id (SA) — market tafsilotida is_online va oxirgi kirish', async () => {
    const res = (await controller.getUserById('26', SUPERADMIN)) as {
      data: Row;
    };
    expect(res.data).toMatchObject({
      id: '26',
      is_online: true,
      last_login_at: '2026-11-27T08:00:00.000Z',
      last_seen_at: '2026-11-27T08:30:00.000Z',
    });
  });

  it('GET /users/:id — kuryer tafsilotida faollik yo`q', async () => {
    const res = (await controller.getUserById('25', SUPERADMIN)) as {
      data: Row;
    };
    expect(res.data).not.toHaveProperty('is_online');
    expect(activityCalls()).toHaveLength(0);
  });

  it('⭐ TC7: menejer — o`zi yaratgan market tafsilotida holat ko`rinadi', async () => {
    identityClient.send.mockImplementation((pattern: Pattern) => {
      if (pattern.cmd === 'identity.user.find_by_id') {
        return of({
          statusCode: 200,
          data: { id: '26', role: 'market', created_by: '520' },
        });
      }
      if (pattern.cmd === 'identity.user.activity.find_by_ids') {
        return of(ACTIVITY);
      }
      return of({ data: [] });
    });
    const res = (await controller.getUserById('26', MANAGER)) as {
      data: Row;
    };
    expect(res.data).toMatchObject({ is_online: true });
    expect(res.data.last_login_at).toBe('2026-11-27T08:00:00.000Z');
  });
});

describe('pe71yf8L — TC6: ruxsat o`zgarmagan', () => {
  it.each(['getUsers', 'getUserById'] as const)(
    '%s — faqat superadmin / admin / menejer (market, kuryer, operator → RolesGuard 403)',
    (method) => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        ApiGatewayController.prototype[method],
      ) as string[];
      expect([...roles].sort()).toEqual(['admin', 'manager', 'superadmin']);
    },
  );
});

describe('pe71yf8L — attachUserActivity', () => {
  it('rolni katta-kichik harfdan qat`i nazar taniydi; id`siz va massiv bo`lmagan qatorlar o`tkaziladi', async () => {
    const send = jest.fn(() => of({ items: [] }));
    const rows: unknown[] = [
      { id: 7, role: 'MARKET' },
      { role: 'market' },
      null,
      'x',
      [{ id: 8, role: 'market' }],
    ];
    await attachUserActivity(rows, {
      identity: { send } as never,
      isPresent: () => false,
    });
    expect(send).toHaveBeenCalledWith(
      { cmd: 'identity.user.activity.find_by_ids' },
      { user_ids: ['7'] },
    );
    expect(rows[0]).toMatchObject({
      is_online: false,
      last_login_at: null,
      last_seen_at: null,
    });
    expect(rows[1]).not.toHaveProperty('is_online');
  });
});
