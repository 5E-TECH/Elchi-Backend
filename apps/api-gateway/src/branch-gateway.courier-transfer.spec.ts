import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NEVER, Observable, of, throwError, TimeoutError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { BranchGatewayController } from './branch-gateway.controller';

/**
 * R3 — kuryerni filialdan filialga o'tkazish marshrutlari:
 *   GET   /couriers/:id/transfer-check → branch.user.courier_transfer_check
 *   PATCH /couriers/:id/branch         → branch.user.transfer_courier
 * HAQIQIY Nest routeri, global ValidationPipe (main.ts dagidek) va global
 * filtrlar orqali: xato tanasida faqat {statusCode, message} qoladi — FE
 * sabablarni aynan `message` dan ko'rsatadi.
 */
describe('BranchGatewayController — kuryer o`tkazish (R3)', () => {
  let app: INestApplication;
  const send = jest.fn();
  const superadmin = { sub: '1', roles: ['superadmin'] };

  beforeAll(async () => {
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
      // Rollar alohida (metadata) tekshiriladi.
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

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const requester = { id: '1', roles: ['superadmin'] };

  beforeEach(() => {
    send.mockReset();
  });

  it('GET /couriers/5/transfer-check → branch.user.courier_transfer_check {user_id, requester}; javob o`zgarmaydi', async () => {
    const body = {
      statusCode: 200,
      message: "Kuryer o'tkazish tekshiruvi",
      data: { user_id: '5', reasons: [], can_transfer: true },
    };
    send.mockReturnValue(of(body));

    const res = await request(http()).get('/couriers/5/transfer-check');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'branch.user.courier_transfer_check' },
      { user_id: '5', requester },
    );
  });

  it.each([['abc'], ['1.5'], ['-1']])(
    "GET /couriers/%s/transfer-check → 400 \"Kuryer id noto'g'ri\", RPC yo'q",
    async (id) => {
      const res = await request(http()).get(`/couriers/${id}/transfer-check`);

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Kuryer id noto'g'ri");
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('PATCH /couriers/5/branch {branch_id} → branch.user.transfer_courier {user_id, branch_id, requester}', async () => {
    const body = {
      statusCode: 200,
      message: "Kuryer 'Samarqand' filialiga o'tkazildi",
      data: {
        user_id: '5',
        from_branch_id: '1',
        to_branch_id: '15',
        region_id: '7',
      },
    };
    send.mockReturnValue(of(body));

    const res = await request(http())
      .patch('/couriers/5/branch')
      .send({ branch_id: '15' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'branch.user.transfer_courier' },
      { user_id: '5', branch_id: '15', requester },
    );
  });

  it.each([
    ["branch_id '1.5'", { branch_id: '1.5' }],
    ["branch_id '-1'", { branch_id: '-1' }],
    ['branch_id son (string emas)', { branch_id: 15 }],
    ["bo'sh tana", {}],
    ['ortiqcha kalit', { branch_id: '15', extra: 1 }],
  ])('PATCH tanasi: %s → 400, RPC yo`q', async (_label, payload) => {
    const res = await request(http())
      .patch('/couriers/5/branch')
      .send(payload as object);

    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("PATCH branch_id noto'g'ri — o'zbekcha xabar", async () => {
    const res = await request(http())
      .patch('/couriers/5/branch')
      .send({ branch_id: '1.5' });

    expect(res.body.message).toContain(
      "branch_id faqat raqamlardan iborat bo'lishi kerak",
    );
  });

  it('PATCH /couriers/abc/branch → 400 "Kuryer id noto\'g\'ri"', async () => {
    const res = await request(http())
      .patch('/couriers/abc/branch')
      .send({ branch_id: '15' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Kuryer id noto'g'ri");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [
      409,
      "Kuryerni boshqa filialga o'tkazib bo'lmaydi: kuryer qo'lida 150 000 so'm pul bor — avval uni Asosiy kassaga qabul qiling (To'lovlar → Qabul qilinishi kerak).",
    ],
    [
      503,
      "Kuryer kassasi va qo'lidagi buyurtmalarni tekshirib bo'lmadi (xizmat javob bermadi). Birozdan so'ng qayta urinib ko'ring.",
    ],
    [404, 'Tanlangan filial topilmadi'],
  ])(
    'branch-service xatosi (%s) — HTTP kodi va message o`zgarmaydi',
    async (statusCode, message) => {
      send.mockReturnValue(throwError(() => ({ statusCode, message })));

      const res = await request(http())
        .patch('/couriers/5/branch')
        .send({ branch_id: '15' });

      expect(res.status).toBe(statusCode);
      expect(res.body).toEqual(
        expect.objectContaining({ statusCode, message }),
      );
    },
  );

  it('tekshiruv xatosi (409 emas, 503) ham o`zgarmaydi', async () => {
    send.mockReturnValue(
      throwError(() => ({ statusCode: 503, message: 'xizmat javob bermadi' })),
    );

    const res = await request(http()).get('/couriers/5/transfer-check');

    expect(res.status).toBe(503);
    expect(res.body.message).toBe('xizmat javob bermadi');
  });
});

describe('BranchGatewayController — R3 rollari', () => {
  const rolesOf = (method: keyof BranchGatewayController) =>
    Reflect.getMetadata(
      ROLES_KEY,
      Object.getOwnPropertyDescriptor(BranchGatewayController.prototype, method)
        ?.value,
    ) as string[];

  it.each([['courierTransferCheck'], ['transferCourierBranch']] as const)(
    '%s — faqat superadmin va admin',
    (method) => {
      expect(rolesOf(method)).toEqual(['superadmin', 'admin']);
    },
  );
});

/**
 * Timeout'lar: har qatlam o'zidan pastdagisidan uzun bo'lishi SHART, aks holda
 * mijoz 504 oladi-yu, amal orqada baribir bajariladi.
 */
describe('BranchGatewayController — R3 timeout`lari', () => {
  const send = jest.fn(() => NEVER);
  const controller = new BranchGatewayController({ send } as never);
  const req = { user: { sub: '1', roles: ['superadmin'] } };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const timesOutAt = (observable: Observable<unknown>, ms: number) => {
    let error: unknown;
    const subscription = observable.subscribe({
      error: (e: unknown) => {
        error = e;
      },
    });
    jest.advanceTimersByTime(ms - 1);
    const early = error;
    jest.advanceTimersByTime(1);
    subscription.unsubscribe();
    return { early, late: error };
  };

  it.each([
    [
      'POST branches/:id/users',
      15_000,
      () =>
        controller.assignUserToBranch('15', { user_id: '263' } as never, req),
    ],
    [
      // C8: sof-nol PENDING yopish (3 s) + qayta tekshiruv (5 s) qo'shiladi.
      'DELETE branches/:id/users/:userId',
      20_000,
      () => controller.removeUserFromBranch('15', '263', req),
    ],
    [
      'GET couriers/:id/transfer-check',
      15_000,
      () => controller.courierTransferCheck('263', req),
    ],
    [
      // C8: oldindan tekshiruv sof-nol holatida 13 s gacha (eng yomon ~32,5 s).
      'PATCH couriers/:id/branch',
      40_000,
      () =>
        controller.transferCourierBranch(
          '263',
          { branch_id: '15' } as never,
          req,
        ),
    ],
  ])('%s — timeout aynan %i ms da', (_label, ms, call) => {
    const { early, late } = timesOutAt(call() as Observable<unknown>, ms);

    expect(early).toBeUndefined();
    expect(late).toBeInstanceOf(TimeoutError);
  });
});
