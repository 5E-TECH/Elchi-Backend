/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { from, of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { BranchGatewayController } from './branch-gateway.controller';
import { SetBranchDistrictsRequestDto } from './dto/branch.swagger.dto';
import { UpdateDistrictRequestDto } from './dto/logistics.swagger.dto';
import { UzValidationPipe } from './validation/uz-validation.pipe';
import { createMemoryBranchService } from '../../branch-service/test/branch-memory-repo';

/**
 * Tuman ↔ filial qamrovi (ega qarori 2026-11-02) — gateway marshrutlari:
 *
 *   GET /branches/:id/districts — SA/ADMIN istalgan filial; MANAGER/REGISTRATOR
 *     faqat o'qiy oladigan filiali (HAQIQIY branch-service `find_by_id` →
 *     `assertCanReadBranch`, boshqasi 403 va logistics chaqirilmaydi); LOGIST —
 *     403 (ega LG-S1: logist doirasiga filial tumanlari kirmaydi).
 *   PUT /branches/:id/districts — faqat SA/ADMIN; payload logistics'ga aynan
 *     (`requester` bilan) uzatiladi; DTO: raqam → satr, takror / >500 rad,
 *     `[]` ruxsat (hammasini bo'shatish).
 *
 * HAQIQIY Nest routeri + RolesGuard + UzValidationPipe (main.ts sozlamasi).
 */

const rolesOf = (method: keyof BranchGatewayController) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    BranchGatewayController.prototype,
    method,
  );
  return Reflect.getMetadata(ROLES_KEY, descriptor?.value) as string[];
};

describe('Tuman qamrovi — marshrut rollari', () => {
  it('GET branches/:id/districts — SA, ADMIN, MANAGER, REGISTRATOR (LOGIST yo‘q, LG-S1)', () => {
    expect(rolesOf('findBranchDistricts')).toEqual([
      'superadmin',
      'admin',
      'manager',
      'registrator',
    ]);
  });

  it('PUT branches/:id/districts — faqat SA va ADMIN', () => {
    expect(rolesOf('setBranchDistricts')).toEqual(['superadmin', 'admin']);
  });
});

/** logistics `find_by_branch` javobi (gateway uni o'zgartirmay qaytaradi). */
const DISTRICTS = [
  {
    id: '101',
    name: 'Andijon tumani',
    region_id: '7',
    assigned_region: null,
    serving_branch_id: '1',
    region: { id: '7', name: 'Andijon' },
    assignedToRegion: null,
  },
  {
    id: '103',
    name: 'Chegara',
    region_id: '8',
    assigned_region: '7',
    serving_branch_id: '1',
    region: { id: '8', name: 'Namangan' },
    assignedToRegion: { id: '7', name: 'Andijon' },
  },
  {
    id: '104',
    name: 'Begona',
    region_id: '7',
    assigned_region: '9',
    serving_branch_id: '1',
    region: { id: '7', name: 'Andijon' },
    assignedToRegion: { id: '9', name: "Farg'ona" },
  },
];

describe('Tuman qamrovi — /branches/:id/districts (HTTP)', () => {
  let app: INestApplication;
  let world: ReturnType<typeof createMemoryBranchService>;
  let user: { sub: string; roles: string[] } | null = null;
  let logisticsReply: (cmd: string, payload: any) => unknown = () => ({});
  /** RMQ xatosi — oddiy obyekt `{ statusCode, message, data }`. */
  let logisticsError: unknown = null;
  const sent: Array<{
    via: 'branch' | 'logistics';
    cmd: string;
    payload: any;
  }> = [];

  /** RMQ transporti kabi: RpcException → {statusCode, message} obyekti. */
  const branchSend = jest.fn((pattern: { cmd: string }, payload: any) => {
    sent.push({ via: 'branch', cmd: pattern.cmd, payload });
    const run = (): Promise<unknown> =>
      pattern.cmd === 'branch.find_by_id'
        ? world.service.findBranchById(payload.id, payload.requester)
        : Promise.reject(new Error('kutilmagan cmd ' + pattern.cmd));
    return from(
      run().catch((error: unknown) => {
        throw error instanceof RpcException ? error.getError() : error;
      }),
    );
  });
  const logisticsSend = jest.fn((pattern: { cmd: string }, payload: any) => {
    sent.push({ via: 'logistics', cmd: pattern.cmd, payload });
    return logisticsError
      ? throwError(() => logisticsError)
      : of(logisticsReply(pattern.cmd, payload));
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BranchGatewayController],
      providers: [
        { provide: 'BRANCH', useValue: { send: branchSend } },
        { provide: 'LOGISTICS', useValue: { send: logisticsSend } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          if (!user) return false;
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            ...user,
            roles: [...user.roles],
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new UzValidationPipe({
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

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  let branchA = '';
  let branchB = '';

  beforeEach(async () => {
    world = createMemoryBranchService();
    sent.length = 0;
    branchSend.mockClear();
    logisticsSend.mockClear();
    logisticsError = null;
    user = { sub: '1', roles: ['superadmin'] };
    logisticsReply = (cmd, payload) =>
      cmd === 'logistics.district.find_by_branch'
        ? { statusCode: 200, message: 'success', data: DISTRICTS }
        : {
            statusCode: 200,
            message: 'Filial xizmat tumanlari yangilandi',
            data: {
              branch_id: payload.branch_id,
              district_ids: payload.district_ids,
              added: payload.district_ids,
              removed: [],
              moved: [],
            },
          };
    branchA = String(
      (
        await world.branchRepo.save({
          name: 'Andijon filiali',
          type: 'REGIONAL',
          region_id: '7',
        })
      ).id,
    );
    branchB = String(
      (
        await world.branchRepo.save({
          name: 'Namangan filiali',
          type: 'REGIONAL',
          region_id: '8',
        })
      ).id,
    );
    await world.branchUserRepo.save({
      branch_id: branchA,
      user_id: '20',
      role: 'MANAGER',
    });
    await world.branchUserRepo.save({
      branch_id: branchA,
      user_id: '21',
      role: 'REGISTRATOR',
    });
  });

  const logisticsCalls = () => sent.filter((call) => call.via === 'logistics');

  describe('GET', () => {
    it.each([['superadmin'], ['admin']])(
      '%s: istalgan filial — faqat logistics find_by_branch, branch tekshiruvi yo‘q',
      async (role) => {
        user = { sub: '1', roles: [role] };

        const res = await request(http()).get(`/branches/${branchB}/districts`);

        expect(res.status).toBe(200);
        expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([
          '101',
          '103',
          '104',
        ]);
        expect(sent).toEqual([
          {
            via: 'logistics',
            cmd: 'logistics.district.find_by_branch',
            payload: { branch_id: branchB },
          },
        ]);
      },
    );

    it.each([
      ['manager', '20'],
      ['registrator', '21'],
    ])(
      '%s: o‘z filiali — branch.find_by_id (o‘z requester’i) → logistics',
      async (role, sub) => {
        user = { sub, roles: [role] };

        const res = await request(http()).get(`/branches/${branchA}/districts`);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(3);
        expect(sent.map((call) => call.cmd)).toEqual([
          'branch.find_by_id',
          'logistics.district.find_by_branch',
        ]);
        expect(sent[0].payload).toEqual({
          id: branchA,
          requester: { id: sub, roles: [role] },
        });
        expect(sent[1].payload).toEqual({ branch_id: branchA });
      },
    );

    it.each([
      ['manager', '20'],
      ['registrator', '21'],
      ['manager', '99'], // hech qaysi filialga biriktirilmagan
    ])(
      '⛔ %s (%s): boshqa filial — 403, logistics chaqirilmaydi',
      async (role, sub) => {
        user = { sub, roles: [role] };

        const res = await request(http()).get(`/branches/${branchB}/districts`);

        expect(res.status).toBe(403);
        expect(logisticsCalls()).toEqual([]);
      },
    );

    // LOGIST — ega LG-S1 (logist-posts-batches-couriers.Z3pUOxou.spec.ts).
    it.each([['logist'], ['courier'], ['market'], ['branch'], ['operator']])(
      '⛔ %s — 403 (RolesGuard), quyi servis chaqirilmaydi',
      async (role) => {
        user = { sub: '5', roles: [role] };

        const res = await request(http()).get(`/branches/${branchA}/districts`);

        expect(res.status).toBe(403);
        expect(sent).toEqual([]);
      },
    );

    it('id raqam emas — 400', async () => {
      const res = await request(http()).get('/branches/abc/districts');

      expect(res.status).toBe(400);
      expect(sent).toEqual([]);
    });
  });

  describe('PUT', () => {
    it('admin: raqam/satr id’lar satrga keltirilib, requester bilan aynan uzatiladi', async () => {
      user = { sub: '3', roles: ['admin'] };

      const res = await request(http())
        .put(`/branches/${branchA}/districts`)
        .send({ district_ids: [101, '102', ' 103 '] });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        branch_id: branchA,
        district_ids: ['101', '102', '103'],
        added: ['101', '102', '103'],
        removed: [],
        moved: [],
      });
      expect(sent).toEqual([
        {
          via: 'logistics',
          cmd: 'logistics.district.set_serving_branch',
          payload: {
            branch_id: branchA,
            district_ids: ['101', '102', '103'],
            requester: { id: '3', roles: ['admin'] },
          },
        },
      ]);
    });

    it('superadmin: bo‘sh ro‘yxat ruxsat (filial tumanlarini bo‘shatish)', async () => {
      const res = await request(http())
        .put(`/branches/${branchA}/districts`)
        .send({ district_ids: [] });

      expect(res.status).toBe(200);
      expect(logisticsCalls()[0].payload).toEqual({
        branch_id: branchA,
        district_ids: [],
        requester: { id: '1', roles: ['superadmin'] },
      });
    });

    it.each([['manager'], ['registrator'], ['logist'], ['courier']])(
      '⛔ %s — 403, logistics chaqirilmaydi',
      async (role) => {
        user = { sub: '20', roles: [role] };

        const res = await request(http())
          .put(`/branches/${branchA}/districts`)
          .send({ district_ids: ['101'] });

        expect(res.status).toBe(403);
        expect(sent).toEqual([]);
      },
    );

    it.each([
      ['takror (raqam va satr)', { district_ids: [5, '5'] }],
      ['takror (bo‘sh joy bilan)', { district_ids: ['5', ' 5 '] }],
      [
        '500 tadan ko‘p',
        { district_ids: Array.from({ length: 501 }, (_, i) => String(i + 1)) },
      ],
      ['maydon yo‘q', {}],
      ['massiv emas', { district_ids: '5' }],
      ['null', { district_ids: null }],
      ['harf', { district_ids: ['abc'] }],
      ['kasr', { district_ids: [1.5] }],
      ['manfiy', { district_ids: [-1] }],
      ['ortiqcha maydon', { district_ids: ['5'], branch_id: '9' }],
    ])('⛔ %s — 400, logistics chaqirilmaydi', async (_label, body) => {
      const res = await request(http())
        .put(`/branches/${branchA}/districts`)
        .send(body);

      expect(res.status).toBe(400);
      expect(sent).toEqual([]);
    });

    it('logistics rad etsa (district_region_mismatch) — status va data.reason o‘tadi', async () => {
      logisticsError = {
        statusCode: 400,
        message: 'Tuman(lar) filial viloyatiga tegishli emas: 201',
        data: {
          reason: 'district_region_mismatch',
          details: { district_ids: ['201'] },
        },
      };

      const res = await request(http())
        .put(`/branches/${branchA}/districts`)
        .send({ district_ids: ['201'] });

      expect(res.status).toBe(400);
      expect(res.body.data).toEqual(
        expect.objectContaining({ reason: 'district_region_mismatch' }),
      );
    });
  });
});

describe('Tuman qamrovi — logistics mijozi yo‘q', () => {
  it('503 (fail-closed), branch tekshiruvi ham qilinmaydi (SA)', async () => {
    const branch = { send: jest.fn() };
    const controller = new BranchGatewayController(branch as never);

    await expect(
      controller.findBranchDistricts('5', {
        user: { sub: '1', roles: ['superadmin'] },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      controller.setBranchDistricts(
        '5',
        { district_ids: ['1'] },
        { user: { sub: '1', roles: ['admin'] } },
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(branch.send).not.toHaveBeenCalled();
  });
});

describe('SetBranchDistrictsRequestDto', () => {
  const check = (body: unknown) => {
    const dto = plainToInstance(SetBranchDistrictsRequestDto, body);
    return { dto, errors: validateSync(dto) };
  };

  it.each([
    [
      [101, '102', ' 103 '],
      ['101', '102', '103'],
    ],
    [[], []],
    [
      Array.from({ length: 500 }, (_, i) => i + 1),
      Array.from({ length: 500 }, (_, i) => String(i + 1)),
    ],
  ])('%p → %p', (input, expected) => {
    const { dto, errors } = check({ district_ids: input });
    expect(errors).toEqual([]);
    expect(dto.district_ids).toEqual(expected);
  });

  it.each([
    [[7, '7']],
    [['7', ' 7']],
    [Array.from({ length: 501 }, (_, i) => i + 1)],
    [['x']],
    [[0.5]],
    [[-3]],
    [['1e3']],
    [[null]],
    ['7'],
    [null],
    [undefined],
  ])('%p — rad etiladi', (input) => {
    expect(check({ district_ids: input }).errors.length).toBeGreaterThan(0);
  });
});

describe('UpdateDistrictRequestDto — rehome_open_orders (ixtiyoriy)', () => {
  const check = (body: unknown) => {
    const dto = plainToInstance(UpdateDistrictRequestDto, body);
    return { dto, errors: validateSync(dto) };
  };

  it.each([[true], [false], [undefined]])('%p — qabul qilinadi', (value) => {
    const { dto, errors } = check({
      assigned_region: '7',
      rehome_open_orders: value,
    });
    expect(errors).toEqual([]);
    expect(dto.rehome_open_orders).toBe(value);
  });

  it.each([['true'], [1], ['yes']])('%p — rad etiladi', (value) => {
    expect(
      check({ assigned_region: '7', rehome_open_orders: value }).errors.length,
    ).toBeGreaterThan(0);
  });
});
