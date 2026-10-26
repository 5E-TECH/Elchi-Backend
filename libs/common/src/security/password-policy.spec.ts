import { validate } from 'class-validator';
import { Roles } from '../../enums';
import {
  IsPasswordPolicy,
  PASSWORD_MIN_LENGTH,
  STAFF_PASSWORD_MIN_LENGTH,
  isPasswordPolicyCompliant,
  passwordMinLength,
  passwordPolicyError,
} from './password-policy';

/** (NDmZMzCP) Parol siyosati: min 8 / xodim 10 + taqiqlangan ro'yxat. */
describe('NDmZMzCP — parol siyosati', () => {
  it('xodim rollari 10, qolganlari 8 (rol noma’lum — 8)', () => {
    for (const role of [
      Roles.SUPERADMIN,
      Roles.ADMIN,
      Roles.MANAGER,
      Roles.REGISTRATOR,
      Roles.OPERATOR,
      Roles.LOGIST,
      Roles.BRANCH,
      Roles.COURIER,
    ]) {
      expect(passwordMinLength(role)).toBe(STAFF_PASSWORD_MIN_LENGTH);
    }
    for (const role of [
      Roles.MARKET,
      Roles.MARKET_OPERATOR,
      Roles.CUSTOMER,
      Roles.INVESTOR,
    ]) {
      expect(passwordMinLength(role)).toBe(PASSWORD_MIN_LENGTH);
    }
    expect(passwordMinLength(undefined)).toBe(PASSWORD_MIN_LENGTH);
    expect(passwordMinLength('ADMIN')).toBe(STAFF_PASSWORD_MIN_LENGTH);
  });

  it('uzunlik: market 8 belgi — OK, 7 — rad; admin 9 — rad, 10 — OK', () => {
    expect(passwordPolicyError('Bozor-2x', { role: Roles.MARKET })).toBeNull();
    expect(passwordPolicyError('Bozor-2', { role: Roles.MARKET })).toBe(
      "Parol kamida 8 belgidan iborat bo'lishi kerak",
    );
    expect(passwordPolicyError('Admin-29x', { role: Roles.ADMIN })).toBe(
      "Parol kamida 10 belgidan iborat bo'lishi kerak",
    );
    expect(passwordPolicyError('Admin-29xy', { role: Roles.ADMIN })).toBeNull();
  });

  it.each([
    '12345678',
    '1234567890',
    'password123',
    'Qwerty123',
    'ELCHI123',
    'elchipochta',
    'aaaaaaaaaa',
    '1111111111',
    '3456789012',
    '9876543210',
    'abcdefghij',
  ])('oddiy parol rad etiladi: %s', (password) => {
    expect(passwordPolicyError(password, { role: Roles.MARKET })).toBe(
      'Parol juda oddiy — boshqa parol tanlang',
    );
  });

  it('telefon raqamining o‘zi parol bo‘lmaydi', () => {
    expect(
      passwordPolicyError('935557711', {
        role: Roles.MARKET,
        phone: '+998935557711',
      }),
    ).toBe("Parol telefon raqami bo'lmasligi kerak");
    expect(
      passwordPolicyError('998935557711', {
        role: Roles.MARKET,
        phone: '+998935557711',
      }),
    ).toBe("Parol telefon raqami bo'lmasligi kerak");
    expect(
      isPasswordPolicyCompliant('935557712', {
        role: Roles.MARKET,
        phone: '+998935557711',
      }),
    ).toBe(true);
  });

  it('bo‘sh, bo‘shliq bilan, 72 baytdan uzun — rad; xabarda parol yo‘q', () => {
    expect(passwordPolicyError('')).toBe("Parol bo'sh bo'lmasligi kerak");
    expect(passwordPolicyError(undefined)).toBe(
      "Parol bo'sh bo'lmasligi kerak",
    );
    expect(passwordPolicyError(' Kuchli-Parol-1 ')).toBe(
      "Parol boshida yoki oxirida bo'sh joy bo'lmasligi kerak",
    );
    expect(passwordPolicyError('x'.repeat(73))).toBe(
      'Parol 72 baytdan oshmasligi kerak',
    );
    const message = passwordPolicyError('Sir-123', { role: Roles.ADMIN });
    expect(message).not.toContain('Sir-123');
  });

  it('@IsPasswordPolicy: qat’iy rol va DTO’dagi rol bo‘yicha', async () => {
    class Fixed {
      @IsPasswordPolicy(Roles.COURIER)
      password!: string;
    }
    class ByRole {
      role!: string;
      @IsPasswordPolicy((dto) => dto.role as string)
      password!: string;
    }
    const fixed = Object.assign(new Fixed(), { password: 'Kuryer-12' });
    const fixedErrors = await validate(fixed);
    expect(fixedErrors[0]?.constraints?.isPasswordPolicy).toBe(
      "Parol kamida 10 belgidan iborat bo'lishi kerak",
    );
    expect(
      await validate(Object.assign(new Fixed(), { password: 'Kuryer-123' })),
    ).toEqual([]);

    expect(
      await validate(
        Object.assign(new ByRole(), {
          role: Roles.CUSTOMER,
          password: 'Mijoz-12',
        }),
      ),
    ).toEqual([]);
    const staff = await validate(
      Object.assign(new ByRole(), { role: Roles.ADMIN, password: 'Mijoz-12' }),
    );
    expect(staff[0]?.constraints?.isPasswordPolicy).toContain('10 belgi');
  });
});
