/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { from } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { BranchGatewayController } from './branch-gateway.controller';
import { createMemoryBranchService } from '../../branch-service/test/branch-memory-repo';

/**
 * 8jtzNlFt + cI5gqN90 — E2E: HAQIQIY gateway routeri (global ValidationPipe
 * main.ts dagidek: whitelist + forbidNonWhitelisted) → RMQ o'rnida
 * HAQIQIY BranchServiceService (xotiradagi jadval). Ilgari
 * `POST /branches {ownership, per_order_share}` → 400 "property ownership
 * should not exist" edi.
 */
describe('BranchGateway E2E — hamkor filial (8jtzNlFt) va xodimlar soni (cI5gqN90)', () => {
  let app: INestApplication;
  let world: ReturnType<typeof createMemoryBranchService>;
  const sent: Array<{ cmd: string; payload: any }> = [];
  const superadmin = { sub: '1', roles: ['superadmin'] };

  /** RMQ transporti kabi: RpcException → {statusCode, message} obyekti. */
  const dispatch = (cmd: string, payload: any): Promise<unknown> => {
    const s = world.service;
    switch (cmd) {
      case 'branch.create':
        return s.createBranch(payload.dto, payload.requester);
      case 'branch.update':
        return s.updateBranch(payload.id, payload.dto, payload.requester);
      case 'branch.find_by_id':
        return s.findBranchById(payload.id, payload.requester);
      case 'branch.find_all':
        return s.findAllBranches(payload.query, payload.requester);
      case 'branch.user.find_by_branch':
        return s.findUsersByBranch(payload.branch_id, payload.requester);
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
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = superadmin;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    world = createMemoryBranchService();
    sent.length = 0;
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  async function createHq(): Promise<string> {
    const res = await request(http())
      .post('/branches')
      .send({ name: 'Bosh ofis', type: 'HQ', code: 'HQ' });
    expect(res.status).toBe(201);
    return String(res.body.data.id);
  }

  it.each([
    ['satr', '5000'],
    ['son', 5000],
  ])(
    "⭐ POST /branches {ownership:'partner', per_order_share: %s} → 201; GET /branches/:id va GET /branches shu qiymatlarni qaytaradi",
    async (_label, share) => {
      const hqId = await createHq();

      const created = await request(http()).post('/branches').send({
        name: 'Hamkor Samarqand',
        type: 'REGIONAL',
        code: 'SAM-P',
        parent_id: hqId,
        ownership: 'partner',
        per_order_share: share,
      });

      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        ownership: 'partner',
        per_order_share: 5000,
      });
      // Gateway → branch-service payloadi: satrga keltirilgan.
      expect(
        sent.find(
          (call) =>
            call.cmd === 'branch.create' && call.payload.dto.code === 'SAM-P',
        )?.payload.dto,
      ).toMatchObject({ ownership: 'partner', per_order_share: '5000' });

      const id = String(created.body.data.id);
      const byId = await request(http()).get(`/branches/${id}`);
      expect(byId.status).toBe(200);
      expect(byId.body.data).toMatchObject({
        id,
        ownership: 'partner',
        per_order_share: 5000,
      });

      const list = await request(http()).get('/branches?limit=100');
      expect(list.status).toBe(200);
      expect(
        list.body.data.items.find((row: any) => String(row.id) === id),
      ).toMatchObject({ ownership: 'partner', per_order_share: 5000 });
    },
  );

  it('PATCH /branches/:id {ownership, per_order_share} → 200 va GET yangi qiymat', async () => {
    const hqId = await createHq();
    const created = await request(http()).post('/branches').send({
      name: 'Namangan',
      type: 'REGIONAL',
      code: 'NAM',
      parent_id: hqId,
    });
    expect(created.body.data).toMatchObject({
      ownership: 'owned',
      per_order_share: 0,
    });
    const id = String(created.body.data.id);

    const patched = await request(http())
      .patch(`/branches/${id}`)
      .send({ ownership: 'partner', per_order_share: '7000.50' });
    expect(patched.status).toBe(200);

    const byId = await request(http()).get(`/branches/${id}`);
    expect(byId.body.data).toMatchObject({
      ownership: 'partner',
      per_order_share: 7000.5,
    });
  });

  it.each([
    ["noto'g'ri ownership", { ownership: 'franchise' }],
    ['manfiy ulush', { ownership: 'partner', per_order_share: '-1' }],
    ['3 kasr', { ownership: 'partner', per_order_share: '1.234' }],
    ['matn ulush', { ownership: 'partner', per_order_share: 'besh' }],
  ])(
    'DTO darajasida 400: %s (branch-service chaqirilmaydi)',
    async (_l, extra) => {
      const res = await request(http())
        .post('/branches')
        .send({
          name: 'X filial',
          type: 'REGIONAL',
          code: 'XF',
          parent_id: '1',
          ...extra,
        });

      expect(res.status).toBe(400);
      expect(sent.filter((call) => call.cmd === 'branch.create')).toHaveLength(
        0,
      );
    },
  );

  it("biznes qoidasi 400 (partner, ulushsiz) — branch-service'dan o'zbekcha xabar", async () => {
    const hqId = await createHq();
    const res = await request(http()).post('/branches').send({
      name: 'Hamkor',
      type: 'REGIONAL',
      code: 'HAM',
      parent_id: hqId,
      ownership: 'partner',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('per_order_share');
  });

  it('⭐ cI5gqN90: 3 xodimli filial — GET /branches va GET /branches/:id da employees_count = 3, created_at bor', async () => {
    const hqId = await createHq();
    const created = await request(http()).post('/branches').send({
      name: 'Andijon',
      type: 'REGIONAL',
      code: 'AND',
      parent_id: hqId,
    });
    const id = String(created.body.data.id);
    for (const [userId, role] of [
      ['11', 'MANAGER'],
      ['12', 'REGISTRATOR'],
      ['13', 'COURIER'],
    ]) {
      await world.branchUserRepo.save({ branch_id: id, user_id: userId, role });
    }

    const list = await request(http()).get('/branches?limit=100');
    const row = list.body.data.items.find((r: any) => String(r.id) === id);
    expect(row.employees_count).toBe(3);
    expect(row.created_at).toBe(row.createdAt);
    expect(typeof row.created_at).toBe('string');

    const detail = await request(http()).get(`/branches/${id}`);
    expect(detail.body.data.employees_count).toBe(3);
    expect(detail.body.data.created_at).toBe(detail.body.data.createdAt);

    const users = await request(http()).get(`/branches/${id}/users`);
    expect(users.body.data).toHaveLength(detail.body.data.employees_count);
  });

  it('marshrut rollari o`zgarmagan: POST/PATCH /branches — faqat SUPERADMIN, ADMIN', () => {
    const proto = BranchGatewayController.prototype as any;
    for (const handler of ['createBranch', 'updateBranch']) {
      expect(Reflect.getMetadata(ROLES_KEY, proto[handler])).toEqual([
        'superadmin',
        'admin',
      ]);
    }
  });
});
