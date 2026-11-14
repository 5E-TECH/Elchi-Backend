import 'reflect-metadata';
import { GatewayTimeoutException, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NEVER, of, throwError } from 'rxjs';
import {
  AI_ADVISOR_ERROR_CODES,
  RMQ_GATEWAY_TIMEOUT,
  publicErrorFields,
  requestContext,
} from '@app/common';
import { AiAdvisorGatewayController } from './ai-advisor-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { AiAdvisorSettingsPatchDto } from './dto/ai-advisor.dto';

/** BE-5 (LhTIno57) — `/ai/advisor/settings`: faqat superadmin, kodli xatolar. */
describe('AiAdvisorGatewayController (BE-5)', () => {
  const req = { user: { sub: 1, roles: ['SUPERADMIN'] } };
  const make = (send: jest.Mock) =>
    new AiAdvisorGatewayController({ send } as unknown as ClientProxy);

  it('marshrutlar: ai/advisor, faqat superadmin, Jwt + Roles guard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiAdvisorGatewayController)).toBe(
      'ai/advisor',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AiAdvisorGatewayController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
    const proto = AiAdvisorGatewayController.prototype as unknown as Record<
      string,
      object
    >;
    for (const [name, method] of [
      ['getSettings', RequestMethod.GET],
      ['updateSettings', RequestMethod.PATCH],
    ] as const) {
      const handler = proto[name];
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('settings');
      // ADMIN ham YO'Q (ega qarori 1) → RolesGuard 403.
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['superadmin']);
    }
  });

  it('GET: requester (rol kichik harf, ism kontekstdan) ai-service’ga, javob o‘zgarishsiz', async () => {
    const reply = {
      statusCode: 200,
      message: 'AI advisor settings',
      data: { version: 1 },
    };
    const send = jest.fn().mockReturnValue(of(reply));
    const out = await requestContext.run(
      { traceId: 't1', userName: 'Shodiyor' },
      () => make(send).getSettings(req),
    );
    expect(out).toBe(reply);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'ai.advisor.settings.get' },
      { requester: { id: '1', roles: ['superadmin'], name: 'Shodiyor' } },
    );
  });

  it('PATCH: tana ai-service’ga patch sifatida', async () => {
    const send = jest.fn().mockReturnValue(of({ statusCode: 200 }));
    const dto = plainToInstance(AiAdvisorSettingsPatchDto, {
      version: 4,
      rules: { R1: { shortage_uzs: 30000 } },
    });
    await make(send).updateSettings(dto, req);
    const [pattern, payload] = send.mock.calls[0] as [
      unknown,
      { patch: unknown },
    ];
    expect(pattern).toEqual({ cmd: 'ai.advisor.settings.update' });
    expect(payload.patch).toEqual({
      version: 4,
      rules: { R1: { shortage_uzs: 30000 } },
    });
  });

  it('DTO: ichki oraliq/uzunlik dekoratori yo‘q — oraliqdan tashqari va version yo‘q gateway’dan o‘tadi (kodli xato ai-service’da)', async () => {
    for (const body of [
      { version: 4, rules: { R1: { consecutive_negative: 1 } } },
      { rules: { R1: { shortage_uzs: 1 } } },
      { version: '4' },
    ]) {
      const errors = await validate(
        plainToInstance(AiAdvisorSettingsPatchDto, body),
        {
          whitelist: true,
          forbidNonWhitelisted: true,
        },
      );
      expect(errors).toEqual([]);
    }
    const bad = await validate(
      plainToInstance(AiAdvisorSettingsPatchDto, { version: 1, rules: 5 }),
    );
    expect(bad.length).toBeGreaterThan(0);
  });

  it('ai-service kodli xatosi o‘zgarishsiz o‘tadi; filtr code+field+min+max chiqaradi', async () => {
    const rpcError = {
      statusCode: 400,
      message: "Qiymat 2 dan 30 gacha butun son bo'lsin",
      data: null,
      code: AI_ADVISOR_ERROR_CODES.INVALID_RULE,
      field: 'rules.R1.consecutive_negative',
      min: 2,
      max: 30,
      secret: 'kesiladi',
    };
    const send = jest.fn().mockReturnValue(throwError(() => rpcError));
    const err = await make(send)
      .updateSettings(
        plainToInstance(AiAdvisorSettingsPatchDto, { version: 1 }),
        req,
      )
      .catch((e: unknown) => e);
    expect(err).toBe(rpcError);
    expect(publicErrorFields(err)).toEqual({
      code: 'AI_ADVISOR_INVALID_RULE',
      field: 'rules.R1.consecutive_negative',
      min: 2,
      max: 30,
    });
    expect(
      publicErrorFields(
        new RpcException({
          statusCode: 409,
          code: 'AI_ADVISOR_SETTINGS_CONFLICT',
          version: 5,
        }).getError(),
      ),
    ).toEqual({ code: 'AI_ADVISOR_SETTINGS_CONFLICT', version: 5 });
  });

  it(`timeout (${RMQ_GATEWAY_TIMEOUT} ms) → 504`, async () => {
    jest.useFakeTimers();
    try {
      const send = jest.fn().mockReturnValue(NEVER);
      const pending = make(send)
        .getSettings(req)
        .catch((e: unknown) => e);
      jest.advanceTimersByTime(RMQ_GATEWAY_TIMEOUT + 1);
      expect(await pending).toBeInstanceOf(GatewayTimeoutException);
    } finally {
      jest.useRealTimers();
    }
  });
});
