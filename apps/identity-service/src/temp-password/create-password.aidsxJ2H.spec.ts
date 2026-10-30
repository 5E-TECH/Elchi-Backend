import { RpcException } from '@nestjs/microservices';
import { Roles } from '@app/common';
import { resolveCreatePassword } from './create-password';

/**
 * (aidsxJ2H) Yaratishdagi parol rejimi: sukut `generate_sms`, `manual`
 * ixtiyoriy bayroq bilan; eski so'rov (faqat `password`) — `manual`.
 */
describe('aidsxJ2H — resolveCreatePassword', () => {
  const ctx = { role: Roles.COURIER, phone: '+998935557711' };

  const errorOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode: number;
        message: string;
      };
    }
    throw new Error('xato kutilgan edi');
  };

  it('hech narsa berilmasa — generate_sms: 12 belgili parol, SMS, must_change', () => {
    const resolved = resolveCreatePassword({}, ctx);
    expect(resolved).toMatchObject({
      mode: 'generate_sms',
      sendSms: true,
      mustChange: true,
    });
    expect(resolved.password).toMatch(/^[A-Za-z2-9]{12}$/);
  });

  it('generate_sms aniq berilsa — must_change_password: true ham qabul', () => {
    expect(
      resolveCreatePassword(
        { password_mode: 'generate_sms', must_change_password: true },
        ctx,
      ),
    ).toMatchObject({ mode: 'generate_sms', mustChange: true });
  });

  it('eski so‘rov (rejimsiz, password bor) — manual, SMS yo‘q, bayroq false', () => {
    expect(
      resolveCreatePassword({ password: 'Kuchli-Parol-2026' }, ctx),
    ).toEqual({
      mode: 'manual',
      password: 'Kuchli-Parol-2026',
      sendSms: false,
      mustChange: false,
    });
  });

  it('manual + must_change_password: true — bayroq yoqiladi', () => {
    expect(
      resolveCreatePassword(
        {
          password_mode: 'manual',
          password: 'Kuchli-Parol-2026',
          must_change_password: true,
        },
        ctx,
      ),
    ).toMatchObject({ mode: 'manual', sendSms: false, mustChange: true });
  });

  it('generate_sms + password — 400 (parolni tizim yaratadi)', () => {
    expect(
      errorOf(() =>
        resolveCreatePassword(
          { password_mode: 'generate_sms', password: 'Kuchli-Parol-2026' },
          ctx,
        ),
      ),
    ).toMatchObject({ statusCode: 400 });
  });

  it('generate_sms + must_change_password: false — 400', () => {
    expect(
      errorOf(() =>
        resolveCreatePassword(
          { password_mode: 'generate_sms', must_change_password: false },
          ctx,
        ),
      ),
    ).toMatchObject({ statusCode: 400 });
  });

  it('manual parolsiz — 400; noma’lum rejim — 400', () => {
    expect(
      errorOf(() => resolveCreatePassword({ password_mode: 'manual' }, ctx)),
    ).toMatchObject({
      statusCode: 400,
      message: 'Parolni kiriting (password_mode: manual)',
    });
    expect(
      errorOf(() => resolveCreatePassword({ password_mode: 'email' }, ctx)),
    ).toMatchObject({ statusCode: 400 });
  });
});
