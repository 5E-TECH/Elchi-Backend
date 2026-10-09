import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { BranchGatewayController } from './branch-gateway.controller';

/**
 * MARSHRUT TARTIBI — `branches/dispatch-destinations` `branches/:id` dan OLDIN
 * e'lon qilinishi SHART.
 *
 * NestJS marshrutni e'lon tartibida moslaydi: statik segment `:id` dan keyin
 * tursa, `GET /branches/dispatch-destinations` `findBranchById`ga
 * `id='dispatch-destinations'` bilan tushadi (u faqat SA/ADMIN uchun — HQ
 * registratori 403 olardi). Tekshiruv HAQIQIY Nest routeri orqali: qaysi `cmd`
 * quyi servisga ketganiga qaraymiz.
 */
describe('BranchGatewayController — marshrut tartibi', () => {
  let app: INestApplication;
  const send = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BranchGatewayController],
      providers: [{ provide: 'BRANCH', useValue: { send } }],
    })
      // Auth bu yerda sinalmaydi — tekshirilayotgani marshrut tanlovi.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** `getHttpServer()` `any` qaytaradi — supertest kutgan tipga bir joyda keltiramiz. */
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeEach(() => {
    send.mockReset();
    send.mockReturnValue(of({ statusCode: 200, data: { items: [] } }));
  });

  type RpcCall = [{ cmd: string }, Record<string, unknown>];
  const lastCall = () => send.mock.calls.at(-1) as RpcCall | undefined;
  const cmdOf = () => lastCall()?.[0].cmd;

  it("GET /branches/dispatch-destinations -> 'branch.dispatch_destinations' (`:id` ga TUSHMAYDI)", async () => {
    const res = await request(http()).get(
      '/branches/dispatch-destinations?region_id=7',
    );

    expect(res.status).toBe(200);
    expect(cmdOf()).toBe('branch.dispatch_destinations');
    expect(cmdOf()).not.toBe('branch.find_by_id');
    expect(lastCall()?.[1]).toEqual(
      expect.objectContaining({ query: { region_id: '7' } }),
    );
  });

  it('GET /branches/dispatch-destinations region_id siz ham ishlaydi', async () => {
    await request(http()).get('/branches/dispatch-destinations');

    expect(cmdOf()).toBe('branch.dispatch_destinations');
    expect(lastCall()?.[1]).toEqual(
      expect.objectContaining({ query: { region_id: undefined } }),
    );
  });

  it("GET /branches/new-orders -> 'branch.new_orders.branches' (`:id` ga TUSHMAYDI)", async () => {
    const res = await request(http()).get('/branches/new-orders');

    expect(res.status).toBe(200);
    expect(cmdOf()).toBe('branch.new_orders.branches');
    expect(cmdOf()).not.toBe('branch.find_by_id');
  });

  it('GET /branches/5 hamon branch.find_by_id ga boradi (regressiya emas)', async () => {
    await request(http()).get('/branches/5');

    expect(cmdOf()).toBe('branch.find_by_id');
    expect(lastCall()?.[1]).toEqual(expect.objectContaining({ id: '5' }));
  });

  it.each(['abc', 'new-order', '1.5', '-1', '12345678901234567890'])(
    '⭐ GET /branches/%s → 400 (500 emas), quyi servisga ketmaydi (RghzFldr)',
    async (id) => {
      const res = await request(http()).get(`/branches/${id}`);

      expect(res.status).toBe(400);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('GET /branches/999999 → find_by_id ga boradi (404 ni servis qaytaradi)', async () => {
    await request(http()).get('/branches/999999');
    expect(cmdOf()).toBe('branch.find_by_id');
  });
});

describe('BranchGatewayController — statik yo`llar `:id` dan OLDIN (RghzFldr TC3)', () => {
  it('⭐ har bir statik `branches/<so`z>` GET `branches/:id` dan oldin e`lon qilingan', () => {
    const proto = BranchGatewayController.prototype as unknown as Record<
      string,
      unknown
    >;
    const getPaths = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        name,
        path: Reflect.getMetadata('path', proto[name]) as string | undefined,
        method: Reflect.getMetadata('method', proto[name]) as
          | number
          | undefined,
      }))
      // RequestMethod.GET === 0
      .filter((r) => r.method === 0 && typeof r.path === 'string');

    const idIndex = getPaths.findIndex((r) => r.path === 'branches/:id');
    expect(idIndex).toBeGreaterThanOrEqual(0);
    const staticAfterId = getPaths
      .slice(idIndex + 1)
      .filter((r) => /^branches\/[^/:]+$/.test(r.path!));
    expect(staticAfterId).toEqual([]);
  });
});

describe('BranchGatewayController — dispatch-destinations rollari', () => {
  const rolesOf = (method: keyof BranchGatewayController) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      BranchGatewayController.prototype,
      method,
    );
    return Reflect.getMetadata(ROLES_KEY, descriptor?.value) as string[];
  };

  it('superadmin, admin va registrator — bor; kuryer, market, menejer — yo‘q', () => {
    const roles = rolesOf('findDispatchDestinations');

    expect(roles).toEqual(['superadmin', 'admin', 'registrator']);
    for (const role of ['courier', 'market', 'manager', 'branch']) {
      expect(roles).not.toContain(role);
    }
  });

  it('GET /branches/:id hamon faqat superadmin/admin (registratorga ochilmagan)', () => {
    expect(rolesOf('findBranchById')).toEqual(['superadmin', 'admin']);
  });
});
