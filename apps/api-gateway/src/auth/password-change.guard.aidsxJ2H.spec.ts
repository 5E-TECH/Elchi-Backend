import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PASSWORD_CHANGE_REQUIRED } from '@app/common';
import {
  ALLOW_DURING_PASSWORD_CHANGE_KEY,
  PasswordChangeGuard,
} from './password-change.guard';
import {
  CreateAdminRequestDto,
  CreateCourierRequestDto,
  CreateMarketRequestDto,
  UpdateAdminRequestDto,
} from '../dto/identity.swagger.dto';
import { ApiGatewayController } from '../api-gateway.controller';

/**
 * (aidsxJ2H) Admin / tizim bergan parol (`pwd_forced`) — darvoza
 * `PASSWORD_CHANGE_GATE` ga QARAMAY ishlaydi (yangi foydalanuvchi parolni
 * almashtirmaguncha boshqa API 403). Eski «zaif parol» bayrog'i
 * (`pwd_change` yolg'iz) — avvalgidek env bilan (mavjud foydalanuvchilar
 * qulflanmaydi).
 */
describe('aidsxJ2H — PasswordChangeGuard: pwd_forced', () => {
  const ctx = (
    user: Record<string, unknown> | undefined,
    handler: () => void = () => undefined,
  ) =>
    ({
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => class Dummy {},
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;
  const guard = (gate: string | undefined) =>
    new PasswordChangeGuard(new Reflector(), { get: () => gate } as never);

  it('darvoza O‘CHIQ bo‘lsa ham pwd_forced — 403 PASSWORD_CHANGE_REQUIRED', () => {
    for (const gate of [undefined, 'off']) {
      let error: unknown;
      try {
        guard(gate).canActivate(ctx({ pwd_change: true, pwd_forced: true }));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        statusCode: 403,
        code: PASSWORD_CHANGE_REQUIRED,
      });
    }
  });

  it('pwd_forced bilan ham parol almashtirish oqimi (my-profile, logout …) ochiq', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(ALLOW_DURING_PASSWORD_CHANGE_KEY, true, handler);
    expect(
      guard(undefined).canActivate(
        ctx({ pwd_change: true, pwd_forced: true }, handler),
      ),
    ).toBe(true);
  });

  it('mavjud foydalanuvchi (faqat pwd_change, zaif eski parol) — darvoza o‘chiq: o‘tadi', () => {
    expect(guard(undefined).canActivate(ctx({ pwd_change: true }))).toBe(true);
  });

  it('pwd_forced, lekin pwd_change yo‘q (parol almashtirilgan) — o‘tadi', () => {
    expect(guard('on').canActivate(ctx({ pwd_forced: true }))).toBe(true);
  });

  it('yangi route’lar: resend-sms / sms-status — parol almashtirish oqimida YO‘Q', () => {
    const proto = ApiGatewayController.prototype as unknown as Record<
      string,
      () => void
    >;
    for (const name of ['resendTempPasswordSms', 'tempPasswordSmsStatus']) {
      expect(typeof proto[name]).toBe('function');
      expect(
        Reflect.getMetadata(ALLOW_DURING_PASSWORD_CHANGE_KEY, proto[name]),
      ).toBeUndefined();
    }
  });
});

describe('aidsxJ2H — yaratish DTO’lari: password_mode', () => {
  const errorsOf = (cls: new () => object, body: Record<string, unknown>) =>
    validateSync(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }).map((error) => error.property);

  const courier = {
    name: 'TEST Claude Kuryer',
    phone_number: '+998935557711',
    tariff_home: 1,
    tariff_center: 1,
  };

  it('parolsiz (generate_sms sukut) — valid', () => {
    expect(errorsOf(CreateCourierRequestDto, courier)).toEqual([]);
    expect(
      errorsOf(CreateAdminRequestDto, {
        name: 'TEST Admin',
        phone_number: '+998935557712',
        salary: 0,
        password_mode: 'generate_sms',
      }),
    ).toEqual([]);
  });

  it('manual + must_change_password + siyosatga mos parol — valid', () => {
    expect(
      errorsOf(CreateMarketRequestDto, {
        name: 'TEST Market',
        phone_number: '+998935557713',
        username: 'test_mkt',
        password: 'Kuchli-Parol-2026',
        password_mode: 'manual',
        must_change_password: true,
        tariff_home: 1,
        tariff_center: 1,
        default_tariff: 'center',
      }),
    ).toEqual([]);
  });

  it('noma’lum password_mode / bool bo‘lmagan bayroq / qisqa parol — xato', () => {
    expect(
      errorsOf(CreateCourierRequestDto, {
        ...courier,
        password_mode: 'email',
        must_change_password: 'ha',
        password: 'qisqa',
      }).sort(),
    ).toEqual(['must_change_password', 'password', 'password_mode']);
  });

  it('PATCH my-profile: old_password qabul qilinadi (forbidNonWhitelisted 400 emas)', () => {
    expect(
      errorsOf(UpdateAdminRequestDto, {
        password: 'Yangi-Parol-2026',
        old_password: 'Eski-Parol',
      }),
    ).toEqual([]);
  });
});
