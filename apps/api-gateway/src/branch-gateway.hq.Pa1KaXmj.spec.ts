/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { from, of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { BranchGatewayController } from './branch-gateway.controller';
import { createMemoryBranchService } from '../../branch-service/test/branch-memory-repo';

/**
 * Pa1KaXmj — `GET /branches/hq` («Markaziy ombor» ochish oynasi uchun HQ):
 * HAQIQIY gateway routeri + HAQIQIY RolesGuard → RMQ o'rnida HAQIQIY
 * BranchServiceService (xotiradagi jadval, `branch.find_hq` / `find_by_id`).
 *
 *   - faqat SUPERADMIN va ADMIN (qolganlar — 403, quyi servisga bormaydi);
 *   - javob — oq ro'yxat: pul/maosh maydonlari (`ownership`,
 *     `per_order_share`, `manager_id`, telefon) chiqmaydi;
 *   - hudud nomi best-effort (olinmasa `region: null`, javob 200);
 *   - HQ yo'q — 404; `branches/:id` ga (`ParseBigintIdPipe` 400) tushmaydi.
 */
describe('Pa1KaXmj — GET /branches/hq', () => {
  let app: INestApplication;
  let world: ReturnType<typeof createMemoryBranchService>;
  let user: { sub: string; roles: string[] } | null = null;
  let findByIdFails = false;
  const sent: Array<{ cmd: string; payload: any }> = [];

  /** RMQ transporti kabi: RpcException → {statusCode, message} obyekti. */
  const dispatch = (cmd: string, payload: any): Promise<unknown> => {
    const s = world.service;
    switch (cmd) {
      case 'branch.find_hq':
        return s.findHqBranch();
      case 'branch.find_by_id':
        if (findByIdFails) return Promise.reject(new Error('timeout'));
        return s.findBranchById(payload.id, payload.requester);
      default:
        return Promise.reject(new Error('kutilmagan cmd ' + cmd));
    }
  };

  beforeAll(async () => {
    const send = jest.fn((pattern: { cmd: string }, payload: any) => {
      sent.push({ cmd: pattern.cmd, payload });
      return from(
        dispatch(pattern.cmd, payload).catch((error: unknown) => {
          throw error instanceof RpcException ? error.getError() : error;
        }),
      );
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [BranchGatewayController],
      providers: [{ provide: 'BRANCH', useValue: { send } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          if (!user) return false;
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            ...user,
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  /** HQ qatori — pul/maosh maydonlari bilan (javobda chiqmasligi kerak). */
  const seedHq = async (extra: Record<string, unknown> = {}) => {
    const saved = await world.branchRepo.save({
      name: 'Bosh ofis (Toshkent)',
      type: 'HQ',
      code: 'HQ-TSHKNT',
      status: 'active',
      address: 'Toshkent, Chilonzor 1',
      phone_number: '+998901112233',
      region_id: '1',
      manager_id: '77',
      ownership: 'owned',
      per_order_share: 15000,
      ...extra,
    });
    return String(saved.id);
  };

  /** branch-service → logistics `region.find_by_ids` javobi. */
  const regionReply = (regions: Array<Record<string, unknown>> | Error) => {
    const logistics = (world.service as any).logisticsClient as {
      send: jest.Mock;
    };
    logistics.send.mockImplementation((pattern: { cmd: string }) =>
      pattern.cmd === 'logistics.region.find_by_ids'
        ? regions instanceof Error
          ? throwError(() => regions)
          : of({ data: regions })
        : of({ data: [] }),
    );
  };

  beforeEach(() => {
    world = createMemoryBranchService();
    sent.length = 0;
    findByIdFails = false;
    user = { sub: '1', roles: ['superadmin'] };
  });

  it('⭐ superadmin: HQ — oq ro`yxat (pul/maosh maydonlarisiz), hudud nomi bilan', async () => {
    const id = await seedHq();
    regionReply([{ id: '1', name: 'Toshkent shahri', code: 'TSH' }]);

    const res = await request(http()).get('/branches/hq');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      statusCode: 200,
      message: 'HQ branch',
      data: {
        id,
        name: 'Bosh ofis (Toshkent)',
        code: 'HQ-TSHKNT',
        type: 'HQ',
        status: 'active',
        address: 'Toshkent, Chilonzor 1',
        region_id: '1',
        region: { id: '1', name: 'Toshkent shahri' },
      },
    });
    const body = JSON.stringify(res.body);
    for (const field of [
      'ownership',
      'per_order_share',
      'manager_id',
      'phone_number',
      '15000',
    ]) {
      expect(body).not.toContain(field);
    }
    expect(sent.map((call) => call.cmd)).toEqual([
      'branch.find_hq',
      'branch.find_by_id',
    ]);
    expect(sent[1].payload).toEqual({
      id,
      requester: { id: '1', roles: ['superadmin'] },
    });
  });

  it('admin ham oladi; hudud olinmasa (logistika yoki find_by_id yiqilsa) — `region: null`, javob 200', async () => {
    user = { sub: '2', roles: ['admin'] };
    await seedHq();
    regionReply(new Error('logistics down'));

    const viaLogistics = await request(http()).get('/branches/hq');
    expect(viaLogistics.status).toBe(200);
    expect(viaLogistics.body.data).toMatchObject({
      type: 'HQ',
      region_id: '1',
      region: null,
    });

    findByIdFails = true;
    const viaDetail = await request(http()).get('/branches/hq');
    expect(viaDetail.status).toBe(200);
    expect(viaDetail.body.data).toMatchObject({ region_id: '1', region: null });
  });

  it('HQ`da region_id yo`q — find_by_id chaqirilmaydi, `region: null`', async () => {
    await seedHq({ region_id: null, address: null, code: null });

    const res = await request(http()).get('/branches/hq');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      code: null,
      address: null,
      region_id: null,
      region: null,
    });
    expect(sent.map((call) => call.cmd)).toEqual(['branch.find_hq']);
  });

  it('⭐ HQ topilmasa — 404 «HQ filial topilmadi»', async () => {
    await world.branchRepo.save({ name: 'Samarqand', type: 'REGIONAL' });

    const res = await request(http()).get('/branches/hq');

    expect(res.status).toBe(404);
    expect(String(res.body.message)).toContain('HQ filial topilmadi');
  });

  it.each([
    ['registrator'],
    ['manager'],
    ['courier'],
    ['market'],
    ['branch'],
    ['logist'],
  ])('⭐ %s — 403, quyi servisga bormaydi', async (role) => {
    await seedHq();
    user = { sub: '9', roles: [role] };

    const res = await request(http()).get('/branches/hq');

    expect(res.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it('rollar metadatasi — faqat superadmin va admin', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      BranchGatewayController.prototype,
      'findHqBranch',
    );
    expect(Reflect.getMetadata(ROLES_KEY, descriptor?.value)).toEqual([
      'superadmin',
      'admin',
    ]);
  });
});

describe('Pa1KaXmj — GET /branches/hq branch-service javob shakli', () => {
  let app: INestApplication;
  const send = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BranchGatewayController],
      providers: [{ provide: 'BRANCH', useValue: { send } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  it("o'ramsiz qator ham o'qiladi; id yo'q javob — 404", async () => {
    send.mockReset();
    send.mockReturnValueOnce(
      of({ id: 3, name: 'HQ', type: 'HQ', status: 'active' }),
    );
    const res = await request(http()).get('/branches/hq');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: '3',
      name: 'HQ',
      code: null,
      type: 'HQ',
      status: 'active',
      address: null,
      region_id: null,
      region: null,
    });
    // `:id` marshrutiga tushmaydi.
    expect(send.mock.calls[0][0]).toEqual({ cmd: 'branch.find_hq' });

    send.mockReturnValueOnce(of({ statusCode: 200, data: null }));
    expect((await request(http()).get('/branches/hq')).status).toBe(404);
  });
});
