import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * GET /orders — saralash parametrlari va qidiruv belgisi gateway'dan o'tadi.
 *
 * ⚠️ Ilgari gateway `sort_by`/`sort_dir` ni umuman qabul qilmasdi (ro'yxat doim
 * createdAt DESC), qidiruv 1000 mijozda kesilganini esa hech kim bilmasdi.
 */
describe('OrderGatewayController GET /orders — saralash va qidiruv', () => {
  let app: INestApplication;
  const orderSend = jest.fn();
  const noop = { send: jest.fn(() => of({ data: {} })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: noop },
        { provide: 'LOGISTICS', useValue: noop },
        { provide: 'BRANCH', useValue: noop },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '1',
            roles: ['admin'],
          };
          return true;
        },
      })
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

  beforeEach(() => {
    orderSend.mockReset();
    orderSend.mockReturnValue(
      of({ data: [], total: 0, page: 1, limit: 10, search_truncated: false }),
    );
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const sentQuery = () =>
    (
      orderSend.mock.calls[0] as [unknown, { query: Record<string, unknown> }]
    )[1].query;

  it("sort_by/sort_dir order-service'ga uzatiladi (butun ro'yxat bo'yicha)", async () => {
    const res = await request(http()).get(
      '/orders?sort_by=total_price&sort_dir=asc&page=2',
    );

    expect(res.status).toBe(200);
    expect((orderSend.mock.calls[0] as unknown[])[0]).toEqual({
      cmd: 'order.find_all_enriched',
    });
    expect(sentQuery()).toMatchObject({
      sort_by: 'total_price',
      sort_dir: 'asc',
      page: 2,
    });
  });

  it('parametrsiz — saralash maydonlari yuborilmaydi (avvalgi tartib)', async () => {
    await request(http()).get('/orders');

    expect(sentQuery().sort_by).toBeUndefined();
    expect(sentQuery().sort_dir).toBeUndefined();
  });

  it("order-service noto'g'ri qiymatni rad etsa -> HTTP 400", async () => {
    orderSend.mockReturnValue(
      throwError(() => ({
        statusCode: 400,
        message:
          "sort_by faqat created_at, total_price, status bo'lishi mumkin",
      })),
    );

    const res = await request(http()).get('/orders?sort_by=customer');

    expect(res.status).toBe(400);
    expect(sentQuery()).toMatchObject({ sort_by: 'customer' });
  });

  it('search_truncated javobda frontendgacha yetib boradi', async () => {
    orderSend.mockReturnValue(
      of({ data: [], total: 0, page: 1, limit: 10, search_truncated: true }),
    );

    const res = await request(http()).get('/orders?search=ali');

    expect(sentQuery()).toMatchObject({ search: 'ali' });
    expect((res.body as { search_truncated?: boolean }).search_truncated).toBe(
      true,
    );
  });
});
