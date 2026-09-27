import 'reflect-metadata';
import {
  BadRequestException,
  GatewayTimeoutException,
  HttpStatus,
  RequestMethod,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ClientProxy } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NEVER, Observable, of, throwError } from 'rxjs';
import { RMQ_GATEWAY_TIMEOUT } from '@app/common';
import { AiGatewayController } from './ai-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  AiUsageSummaryQueryDto,
  RaiseAiCapRequestDto,
} from './dto/ai.swagger.dto';

/**
 * `/ai/*` admin endpointlari (wFSMEIIy #10, lYVuADRE, bVeyEuIR; PLAN C8):
 * rol metama'lumoti, payload moslashuvi, timeout → 504.
 */
describe('AiGatewayController', () => {
  const setup = (reply: () => Observable<unknown> = () => of({ ok: 1 })) => {
    const send = jest.fn<Observable<unknown>, [unknown, unknown]>(() =>
      reply(),
    );
    const controller = new AiGatewayController({
      send,
    } as unknown as ClientProxy);
    return { controller, send };
  };

  const handlerOf = (name: keyof AiGatewayController) =>
    Object.getOwnPropertyDescriptor(AiGatewayController.prototype, name)
      ?.value as object;

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('marshrut va rol metama’lumoti', () => {
    it("controller '/ai' da", () => {
      expect(Reflect.getMetadata(PATH_METADATA, AiGatewayController)).toBe(
        'ai',
      );
    });

    it.each([
      ['status', RequestMethod.GET, 'status', ['superadmin', 'admin']],
      ['raiseCap', RequestMethod.POST, 'cap/raise', ['superadmin']],
      [
        'usageSummary',
        RequestMethod.GET,
        'usage/summary',
        ['superadmin', 'admin'],
      ],
    ] as const)(
      '%s → %s /ai/%s, rollar %j, JwtAuthGuard + RolesGuard',
      (name, method, path, roles) => {
        const handler = handlerOf(name);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
        expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(roles);
        expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
          JwtAuthGuard,
          RolesGuard,
        ]);
      },
    );

    it('cap/raise 200 qaytaradi (201 emas)', () => {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('raiseCap')),
      ).toBe(HttpStatus.OK);
    });
  });

  describe('payload moslashuvi', () => {
    it('GET /ai/status → ai.status {} → successRes(data)', async () => {
      const status = { enabled: true, key_state: 'ok' };
      const { controller, send } = setup(() => of(status));

      await expect(controller.status()).resolves.toEqual({
        statusCode: 200,
        message: 'success',
        data: status,
      });
      expect(send).toHaveBeenCalledWith({ cmd: 'ai.status' }, {});
    });

    it('POST /ai/cap/raise → ai.cap.raise {extra_usd, reason, requester:{id: sub, roles}}', async () => {
      const reply = {
        period_key: '2026-09-27',
        override_usd: 10,
        effective_cap_usd: 60,
      };
      const { controller, send } = setup(() => of(reply));

      await expect(
        controller.raiseCap(
          { extra_usd: 10, reason: 'Aksiya kuni' } as RaiseAiCapRequestDto,
          { user: { sub: 7, roles: ['superadmin'] } },
        ),
      ).resolves.toEqual({ statusCode: 200, message: 'success', data: reply });
      expect(send).toHaveBeenCalledWith(
        { cmd: 'ai.cap.raise' },
        {
          extra_usd: 10,
          reason: 'Aksiya kuni',
          requester: { id: '7', roles: ['superadmin'] },
        },
      );
    });

    it('GET /ai/usage/summary → ai.usage.summary {from, to}', async () => {
      const summary = { total_usd: 1.5, calls: 3 };
      const { controller, send } = setup(() => of(summary));

      await expect(
        controller.usageSummary({ from: '2026-09-01', to: '2026-09-27' }),
      ).resolves.toEqual({
        statusCode: 200,
        message: 'success',
        data: summary,
      });
      expect(send).toHaveBeenCalledWith(
        { cmd: 'ai.usage.summary' },
        { from: '2026-09-01', to: '2026-09-27' },
      );
    });

    it('sana berilmasa bo‘sh payload (ai-service oxirgi 30 kunni oladi)', async () => {
      const { controller, send } = setup(() => of({}));
      await controller.usageSummary({});
      expect(send).toHaveBeenCalledWith({ cmd: 'ai.usage.summary' }, {});
    });

    it('from > to → 400, RPC yuborilmaydi', async () => {
      const { controller, send } = setup();
      await expect(
        controller.usageSummary({ from: '2026-09-27', to: '2026-09-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('timeout', () => {
    it.each([
      ['status', (c: AiGatewayController) => c.status()],
      [
        'raiseCap',
        (c: AiGatewayController) =>
          c.raiseCap({ extra_usd: 1, reason: 'x' } as RaiseAiCapRequestDto, {
            user: { sub: '1', roles: ['superadmin'] },
          }),
      ],
      ['usageSummary', (c: AiGatewayController) => c.usageSummary({})],
    ])(
      `%s: ai-service ${RMQ_GATEWAY_TIMEOUT}ms javob bermasa → 504 GatewayTimeoutException`,
      async (_name, invoke) => {
        jest.useFakeTimers();
        const { controller, send } = setup(() => NEVER);

        const pending = invoke(controller);
        const assertion = expect(pending).rejects.toBeInstanceOf(
          GatewayTimeoutException,
        );
        await jest.advanceTimersByTimeAsync(RMQ_GATEWAY_TIMEOUT);
        await assertion;
        // Qayta urinish YO'Q — bitta yuborish.
        expect(send).toHaveBeenCalledTimes(1);
      },
    );

    it('timeout’dan oldin javob kelsa muvaffaqiyatli', async () => {
      jest.useFakeTimers();
      const { controller } = setup(
        () =>
          new Observable((subscriber) => {
            const handle = setTimeout(() => {
              subscriber.next({ enabled: true });
              subscriber.complete();
            }, RMQ_GATEWAY_TIMEOUT - 100);
            return () => clearTimeout(handle);
          }),
      );
      const pending = controller.status();
      await jest.advanceTimersByTimeAsync(RMQ_GATEWAY_TIMEOUT - 100);
      await expect(pending).resolves.toMatchObject({
        data: { enabled: true },
      });
    });

    it('boshqa RPC xatosi o‘zgarishsiz uzatiladi', async () => {
      const rpcError = { statusCode: 400, message: 'reason majburiy' };
      const { controller } = setup(() => throwError(() => rpcError));
      await expect(controller.status()).rejects.toBe(rpcError);
    });
  });

  describe('DTO validatsiyasi', () => {
    const errorsOf = async <T extends object>(
      cls: new () => T,
      body: Record<string, unknown>,
    ) => {
      const errors = await validate(plainToInstance(cls, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      return errors.map((error) => error.property);
    };

    it('RaiseAiCapRequestDto: to‘g‘ri tana qabul qilinadi', async () => {
      expect(
        await errorsOf(RaiseAiCapRequestDto, {
          extra_usd: 10.5,
          reason: 'Aksiya kuni',
        }),
      ).toEqual([]);
      expect(
        await errorsOf(RaiseAiCapRequestDto, { extra_usd: 0.01, reason: 'x' }),
      ).toEqual([]);
    });

    it.each([
      [{ extra_usd: 0, reason: 'x' }, 'extra_usd'],
      [{ extra_usd: -5, reason: 'x' }, 'extra_usd'],
      [{ extra_usd: '10', reason: 'x' }, 'extra_usd'],
      [{ reason: 'x' }, 'extra_usd'],
      [{ extra_usd: 5 }, 'reason'],
      [{ extra_usd: 5, reason: '   ' }, 'reason'],
      [{ extra_usd: 5, reason: 'a'.repeat(256) }, 'reason'],
      [{ extra_usd: 5, reason: 'x', market_id: '1' }, 'market_id'],
    ])('RaiseAiCapRequestDto: %j → %s xato', async (body, property) => {
      expect(await errorsOf(RaiseAiCapRequestDto, body)).toContain(property);
    });

    it('AiUsageSummaryQueryDto: YYYY-MM-DD yoki bo‘sh qabul qilinadi', async () => {
      expect(await errorsOf(AiUsageSummaryQueryDto, {})).toEqual([]);
      expect(
        await errorsOf(AiUsageSummaryQueryDto, {
          from: '2026-09-01',
          to: '2026-09-27',
        }),
      ).toEqual([]);
      expect(await errorsOf(AiUsageSummaryQueryDto, { from: '' })).toEqual([]);
    });

    it.each([
      [{ from: '2026-9-1' }, 'from'],
      [{ from: '2026-13-01' }, 'from'],
      [{ to: '27.09.2026' }, 'to'],
      [{ to: '2026-09-27T00:00:00Z' }, 'to'],
      [{ from: "2026-09-01' OR 1=1" }, 'from'],
      [{ market_id: '1' }, 'market_id'],
    ])('AiUsageSummaryQueryDto: %j → %s xato', async (query, property) => {
      expect(await errorsOf(AiUsageSummaryQueryDto, query)).toContain(property);
    });
  });
});
