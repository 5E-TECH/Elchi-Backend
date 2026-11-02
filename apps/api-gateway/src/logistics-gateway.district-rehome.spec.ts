/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import 'reflect-metadata';
import {
  ExecutionContext,
  HttpStatus,
  INestApplication,
  RequestMethod,
} from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { ClientProxy } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { firstValueFrom, of } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { UpdateDistrictRequestDto } from './dto/logistics.swagger.dto';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { ParseBigintIdPipe } from './pipes/parse-bigint-id.pipe';
import { UzValidationPipe } from './validation/uz-validation.pipe';

/**
 * Tuman boshqa viloyatga o'tkazilgach HQ'ning eski viloyat YANGI pochtasida
 * qolgan buyurtmalarni ko'chirish (ega qarori: buyurtma viloyati o'zgarmaydi,
 * faqat pochta a'zoligi):
 *
 *   POST /district/:id/rehome-open-orders — faqat SA/ADMIN, tana yo'q;
 *     `logistics.district.rehome_open_orders` ga `{ id, requester }`.
 *   PATCH /district/:id — `rehome_open_orders` (ixtiyoriy boolean) dto bilan
 *     logistics'ga o'tadi (natija `data.rehome` — logistics'da).
 */

const REHOME_RESULT = {
  statusCode: 200,
  message: 'success',
  data: {
    district_id: '1401',
    target_region_id: '9',
    moved: 2,
    order_ids: ['1001', '1002'],
    from_post_ids: ['900'],
    to_post_id: '905',
    skipped: [{ order_id: '1003', reason: 'not_in_new_post' }],
  },
};

describe('POST district/:id/rehome-open-orders — metadata', () => {
  const handler = Object.getOwnPropertyDescriptor(
    LogisticsGatewayController.prototype,
    'rehomeDistrictOpenOrders',
  )?.value as object;

  it('marshrut: POST district/:id/rehome-open-orders, 200 (201 emas)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'district/:id/rehome-open-orders',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.OK,
    );
  });

  it('faqat superadmin va admin (PATCH district/:id bilan bir xil)', () => {
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect(roles).toEqual(['superadmin', 'admin']);
    const patchRoles = Reflect.getMetadata(
      ROLES_KEY,
      Object.getOwnPropertyDescriptor(
        LogisticsGatewayController.prototype,
        'update',
      )?.value as object,
    ) as string[];
    expect([...roles].sort()).toEqual([...patchRoles].sort());
  });

  it('id ParseBigintIdPipe bilan tekshiriladi', () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      LogisticsGatewayController,
      'rehomeDistrictOpenOrders',
    ) as Record<string, { data?: string; pipes?: unknown[] }>;
    const idArg = Object.values(args).find((a) => a.data === 'id');
    expect(idArg?.pipes).toContain(ParseBigintIdPipe);
  });
});

describe('POST district/:id/rehome-open-orders — payload', () => {
  const build = () => {
    const logisticsClient = { send: jest.fn(() => of(REHOME_RESULT)) };
    const controller = new LogisticsGatewayController(
      logisticsClient as unknown as ClientProxy,
      { send: jest.fn() } as unknown as ClientProxy,
    );
    return { controller, logisticsClient };
  };

  it("{ id, requester: { id, roles } } uzatiladi, javob o'zgarmay qaytadi", async () => {
    const { controller, logisticsClient } = build();

    const res = await firstValueFrom(
      controller.rehomeDistrictOpenOrders('1401', {
        user: { sub: '7', roles: ['admin'] },
      }),
    );

    expect(logisticsClient.send).toHaveBeenCalledTimes(1);
    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.district.rehome_open_orders' },
      { id: '1401', requester: { id: '7', roles: ['admin'] } },
    );
    expect(res).toEqual(REHOME_RESULT);
  });

  it("tokenda roles yo'q — requester.roles = [] (logistics 403 beradi)", async () => {
    const { controller, logisticsClient } = build();

    await firstValueFrom(
      controller.rehomeDistrictOpenOrders('1401', { user: { sub: '7' } }),
    );

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.district.rehome_open_orders' },
      { id: '1401', requester: { id: '7', roles: [] } },
    );
  });
});

describe('UpdateDistrictRequestDto — rehome_open_orders', () => {
  const check = (body: unknown) => {
    const dto = plainToInstance(UpdateDistrictRequestDto, body);
    return { dto, errors: validateSync(dto) };
  };

  it.each([[true], [false], [undefined]])('%p — qabul qilinadi', (value) => {
    const { dto, errors } = check({
      assigned_region: '9',
      rehome_open_orders: value,
    });
    expect(errors).toEqual([]);
    expect(dto.rehome_open_orders).toBe(value);
  });

  it.each([['true'], ['false'], [1], [0], ['yes'], [{}]])(
    '%p — rad etiladi (o‘zbekcha xabar)',
    (value) => {
      const { errors } = check({
        assigned_region: '9',
        rehome_open_orders: value,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('rehome_open_orders');
      expect(Object.values(errors[0].constraints ?? {})).toEqual([
        "rehome_open_orders true yoki false bo'lishi kerak",
      ]);
    },
  );
});

/**
 * HAQIQIY Nest routeri + RolesGuard + UzValidationPipe (main.ts sozlamasi):
 * yo'l boshqa `district/*` marshrutlari bilan to'qnashmaydi, rol va id
 * tekshiruvi logistics'ga yetmasdan ishlaydi.
 */
describe('district rehome — HTTP', () => {
  let app: INestApplication;
  let user: { sub: string; roles: string[] } | null = null;
  const logisticsSend = jest.fn((pattern: { cmd: string }, payload: any) =>
    of(
      pattern.cmd === 'logistics.district.rehome_open_orders'
        ? REHOME_RESULT
        : { statusCode: 200, message: 'success', data: { payload } },
    ),
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LogisticsGatewayController],
      providers: [
        { provide: 'LOGISTICS', useValue: { send: logisticsSend } },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
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

  beforeEach(() => {
    logisticsSend.mockClear();
    user = { sub: '1', roles: ['superadmin'] };
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const cmds = () =>
    (logisticsSend.mock.calls as unknown[][]).map(
      ([pattern]) => (pattern as { cmd: string }).cmd,
    );

  it.each([['superadmin'], ['admin']])(
    '%s — 200, logistics.district.rehome_open_orders ga uzatiladi',
    async (role) => {
      user = { sub: '5', roles: [role] };

      const res = await request(http())
        .post('/district/1401/rehome-open-orders')
        .expect(200);

      expect(res.body).toEqual(REHOME_RESULT);
      expect(logisticsSend.mock.calls).toEqual([
        [
          { cmd: 'logistics.district.rehome_open_orders' },
          { id: '1401', requester: { id: '5', roles: [role] } },
        ],
      ]);
    },
  );

  it.each([['manager'], ['registrator'], ['logist'], ['courier'], ['market']])(
    '%s — 403, logistics chaqirilmaydi',
    async (role) => {
      user = { sub: '5', roles: [role] };

      await request(http())
        .post('/district/1401/rehome-open-orders')
        .expect(403);

      expect(logisticsSend).not.toHaveBeenCalled();
    },
  );

  it('id raqam emas — 400, logistics chaqirilmaydi', async () => {
    await request(http()).post('/district/abc/rehome-open-orders').expect(400);

    expect(logisticsSend).not.toHaveBeenCalled();
  });

  it("qo'shni POST district/* marshrutlari o'z cmd'iga boradi (to'qnashuv yo'q)", async () => {
    await request(http()).post('/district/sato-match/apply').expect(201);
    await request(http()).post('/district/1401/rehome-open-orders').expect(200);

    expect(cmds()).toEqual([
      'logistics.district.sato_match_apply',
      'logistics.district.rehome_open_orders',
    ]);
  });

  it('PATCH district/:id — rehome_open_orders: true dto bilan logistics.district.update ga o‘tadi', async () => {
    await request(http())
      .patch('/district/1401')
      .send({ assigned_region: 9, rehome_open_orders: true })
      .expect(200);

    expect(logisticsSend.mock.calls).toEqual([
      [
        { cmd: 'logistics.district.update' },
        {
          id: '1401',
          dto: expect.objectContaining({
            assigned_region: '9',
            rehome_open_orders: true,
          }),
          requester: { id: '1', roles: ['superadmin'] },
        },
      ],
    ]);
  });

  it("PATCH district/:id — rehome_open_orders: 'true' (satr) — 400, logistics chaqirilmaydi", async () => {
    const res = await request(http())
      .patch('/district/1401')
      .send({ assigned_region: '9', rehome_open_orders: 'true' })
      .expect(400);

    expect(JSON.stringify(res.body)).toContain(
      "rehome_open_orders true yoki false bo'lishi kerak",
    );
    expect(logisticsSend).not.toHaveBeenCalled();
  });
});
