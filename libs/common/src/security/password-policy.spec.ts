import { validate } from 'class-validator';
import { Roles } from '../../enums';
import {
  IsPasswordPolicy,
  PASSWORD_MIN_LENGTH,
  isPasswordPolicyCompliant,
  passwordPolicyError,
} from './password-policy';

/**
 * (NDmZMzCP) Parol siyosati. Ega qarori 2026-11-02: hamma rol uchun kamida 6
 * belgi, 1 ta katta harf, 1 ta kichik harf va 1 ta raqam + taqiqlangan ro'yxat.
 */
describe('NDmZMzCP — parol siyosati', () => {
  it('hamma rol uchun bir xil: 6 belgi — OK, 5 — rad', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(6);
    for (const role of [
      Roles.SUPERADMIN,
      Roles.ADMIN,
      Roles.COURIER,
      Roles.MARKET,
      Roles.MARKET_OPERATOR,
      Roles.CUSTOMER,
      undefined,
    ]) {
      expect(passwordPolicyError('Bozor7', { role })).toBeNull();
      expect(passwordPolicyError('Boz7a', { role })).toBe(
        "Parol kamida 6 belgidan iborat bo'lishi kerak",
      );
    }
  });

  it('katta harf, kichik harf va raqam majburiy', () => {
    expect(passwordPolicyError('bozor77')).toBe(
      "Parolda kamida 1 ta katta harf bo'lishi kerak",
    );
    expect(passwordPolicyError('BOZOR77')).toBe(
      "Parolda kamida 1 ta kichik harf bo'lishi kerak",
    );
    expect(passwordPolicyError('Bozorcha')).toBe(
      "Parolda kamida 1 ta raqam bo'lishi kerak",
    );
    expect(passwordPolicyError('QWERT12345')).toBe(
      "Parolda kamida 1 ta kichik harf bo'lishi kerak",
    );
    // Kirill harflari ham harf hisoblanadi.
    expect(passwordPolicyError('Бозор77')).toBeNull();
    expect(isPasswordPolicyCompliant('Kuchli-Parol-2026')).toBe(true);
  });

  it.each([
    'Password123',
    'Qwerty123',
    'Elchi123',
    'Elchipochta1',
    'Admin12345',
    'Aa123456',
    'Test1234',
  ])('oddiy parol rad etiladi: %s', (password) => {
    expect(passwordPolicyError(password, { role: Roles.MARKET })).toBe(
      'Parol juda oddiy — boshqa parol tanlang',
    );
  });

  it('faqat raqamdan iborat parol (telefon ham) harf talabi bilan rad etiladi', () => {
    expect(
      passwordPolicyError('935557711', {
        role: Roles.MARKET,
        phone: '+998935557711',
      }),
    ).toBe("Parolda kamida 1 ta katta harf bo'lishi kerak");
    expect(
      isPasswordPolicyCompliant('Tel935557711', {
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
    const message = passwordPolicyError('sir-1234', { role: Roles.ADMIN });
    expect(message).toBeTruthy();
    expect(message).not.toContain('sir-1234');
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
    const fixed = Object.assign(new Fixed(), { password: 'Kur-1' });
    const fixedErrors = await validate(fixed);
    expect(fixedErrors[0]?.constraints?.isPasswordPolicy).toBe(
      "Parol kamida 6 belgidan iborat bo'lishi kerak",
    );
    expect(
      await validate(Object.assign(new Fixed(), { password: 'Kuryer1' })),
    ).toEqual([]);

    expect(
      await validate(
        Object.assign(new ByRole(), {
          role: Roles.CUSTOMER,
          password: 'Mijoz-12',
        }),
      ),
    ).toEqual([]);
    const weak = await validate(
      Object.assign(new ByRole(), { role: Roles.ADMIN, password: 'mijoz-12' }),
    );
    expect(weak[0]?.constraints?.isPasswordPolicy).toContain('katta harf');
  });
});
