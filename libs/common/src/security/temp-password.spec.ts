import { Roles } from '../../enums';
import { isPasswordPolicyCompliant } from './password-policy';
import {
  TEMP_PASSWORD_ALPHABET,
  TEMP_PASSWORD_LENGTH,
  generateTempPassword,
  passwordSmsFailureMessage,
} from './temp-password';

/**
 * (aidsxJ2H) Tizim yaratadigan vaqtinchalik parol: 12 belgi, chalkash
 * belgilarsiz, katta+kichik harf+raqam, parol siyosatiga (xodim 10) doim mos.
 */
describe('aidsxJ2H — generateTempPassword', () => {
  const samples = Array.from({ length: 300 }, () =>
    generateTempPassword({ role: Roles.COURIER, phone: '+998935557711' }),
  );

  it('12 belgi, faqat ruxsat etilgan alifbo (0 O o 1 l I i yo‘q)', () => {
    for (const password of samples) {
      expect(password).toHaveLength(TEMP_PASSWORD_LENGTH);
      expect(
        [...password].every((c) => TEMP_PASSWORD_ALPHABET.includes(c)),
      ).toBe(true);
      expect(password).not.toMatch(/[0O1lIio]/);
    }
  });

  it('har birida katta harf, kichik harf va raqam bor', () => {
    for (const password of samples) {
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[2-9]/);
    }
  });

  it('parol siyosatiga mos (xodim — 10 belgi, oddiy/ketma-ket emas)', () => {
    for (const password of samples) {
      expect(
        isPasswordPolicyCompliant(password, {
          role: Roles.ADMIN,
          phone: '+998935557711',
        }),
      ).toBe(true);
    }
  });

  it('takrorlanmaydi (kriptografik tasodif)', () => {
    expect(new Set(samples).size).toBe(samples.length);
  });

  it('failure_reason → o‘zbekcha sabab; noma’lum — umumiy matn; bo‘sh — null', () => {
    expect(passwordSmsFailureMessage('invalid_phone')).toBe(
      "Telefon raqami noto'g'ri — SMS yuborilmadi",
    );
    expect(passwordSmsFailureMessage('sms_disabled')).toBe(
      "SMS yuborish hozir o'chirilgan",
    );
    expect(passwordSmsFailureMessage('something_new')).toBe(
      "SMS yuborilmadi — qayta urinib ko'ring",
    );
    expect(passwordSmsFailureMessage(null)).toBeNull();
  });
});
