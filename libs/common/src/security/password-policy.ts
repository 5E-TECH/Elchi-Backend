import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';

/**
 * (NDmZMzCP, 2026-10-26) Parol siyosati — YANGI parol o'rnatilganda /
 * almashtirilganda (yaratish, tahrirlash, o'z profili). LOGIN'ga TEGMAYDI:
 * mavjud foydalanuvchi eski paroli bilan kira oladi — u faqat
 * `must_change_password` bilan belgilanadi (auth.service `login`).
 *
 *  - ega qarori 2026-11-02: hamma rol uchun kamida 6 belgi, kamida 1 ta
 *    katta harf, 1 ta kichik harf va 1 ta raqam (ilgari 8, xodimlar 10);
 *  - ko'pi bilan 72 bayt (bcrypt shundan keyingisini e'tiborsiz qoldiradi);
 *  - taqiqlangan ro'yxat: keng tarqalgan parollar (`12345678`, `password`,
 *    `qwerty123`, `elchi123` …), bitta belgining takrori (`aaaaaaaa`),
 *    ketma-ket raqam/harf (`123456789`, `abcdefgh`) va foydalanuvchining o'z
 *    telefon raqami.
 *
 * RMQ'da ValidationPipe yo'q — shuning uchun identity-service parolni
 * xeshlashdan OLDIN `passwordPolicyError` bilan o'zi ham tekshiradi; DTO
 * dekoratori (`@IsPasswordPolicy`) faqat gateway'dagi birinchi to'siq.
 */
export const PASSWORD_MIN_LENGTH = 6;
/** bcrypt 72 baytdan keyingisini kesib tashlaydi — undan uzun parol aldaydi. */
export const PASSWORD_MAX_BYTES = 72;

/** Keng tarqalgan parollar (kichik harfda). Tekshiruv — to'liq moslik. */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '0123456789',
  '12345678910',
  '87654321',
  '987654321',
  '9876543210',
  '11223344',
  '12341234',
  '12121212',
  '11112222',
  '123123123',
  '123321123',
  '1q2w3e4r',
  '1q2w3e4r5t',
  '1qaz2wsx',
  'qwertyui',
  'qwertyuiop',
  'qwerty12',
  'qwerty123',
  'qwerty1234',
  'qwerty12345',
  'asdfghjk',
  'asdfghjkl',
  'zxcvbnm1',
  'zxcvbnm123',
  'password',
  'password1',
  'password12',
  'password123',
  'passw0rd',
  'p@ssw0rd',
  'p@ssword',
  'iloveyou',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'welcome1',
  'welcome123',
  'abc12345',
  'abcd1234',
  'abc123456',
  'aa123456',
  'a1234567',
  'a12345678',
  'admin123',
  'admin1234',
  'admin12345',
  'administrator',
  'superadmin',
  'superadmin1',
  'superadmin123',
  'manager123',
  'courier123',
  'kuryer123',
  'market123',
  'operator123',
  'elchi123',
  'elchi1234',
  'elchi12345',
  'elchipochta',
  'elchipochta1',
  'elchipochta123',
  'elchi2024',
  'elchi2025',
  'elchi2026',
  'parol123',
  'parol1234',
  'parolim1',
  'parolim123',
  'toshkent',
  'tashkent',
  'tashkent123',
  'uzbekistan',
  'uzbekiston',
  'samarqand',
  'qwerty7777',
  '77777777',
  '99999999',
  '998901234567',
  'letmein1',
  'changeme',
  'changeme1',
  'default1',
  'test1234',
  'test12345',
  'testtest',
]);

/** Barcha belgilar bir xil (`aaaaaaaa`, `11111111`). */
function isSingleCharRepeat(value: string): boolean {
  return value.length > 0 && [...value].every((char) => char === value[0]);
}

/** Butunlay ketma-ket raqam yoki harf (o'suvchi/kamayuvchi): `3456789012` ham. */
function isSequential(value: string): boolean {
  if (value.length < 4) return false;
  const lower = value.toLowerCase();
  const alphabets = ['0123456789', 'abcdefghijklmnopqrstuvwxyz'];
  return alphabets.some((alphabet) => {
    const cyclic = alphabet.repeat(3);
    const reversed = [...cyclic].reverse().join('');
    return cyclic.includes(lower) || reversed.includes(lower);
  });
}

export interface PasswordPolicyContext {
  /** Parol egasining roli (qoida hamma rolga bir xil). */
  role?: string | null;
  /** Egasining telefoni — parol telefon raqamining o'zi bo'lmasin. */
  phone?: string | null;
}

/**
 * Parol siyosatga mos emasligi sababi (o'zbekcha, FE ko'rsatadi) yoki `null`.
 * Parolning o'zi xabarda HECH QACHON qaytmaydi.
 */
export function passwordPolicyError(
  password: unknown,
  context: PasswordPolicyContext = {},
): string | null {
  if (typeof password !== 'string' || password.length === 0) {
    return "Parol bo'sh bo'lmasligi kerak";
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Parol kamida ${PASSWORD_MIN_LENGTH} belgidan iborat bo'lishi kerak`;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return `Parol ${PASSWORD_MAX_BYTES} baytdan oshmasligi kerak`;
  }
  if (password.trim() !== password) {
    return "Parol boshida yoki oxirida bo'sh joy bo'lmasligi kerak";
  }
  if (!/\p{Lu}/u.test(password)) {
    return "Parolda kamida 1 ta katta harf bo'lishi kerak";
  }
  if (!/\p{Ll}/u.test(password)) {
    return "Parolda kamida 1 ta kichik harf bo'lishi kerak";
  }
  if (!/\d/.test(password)) {
    return "Parolda kamida 1 ta raqam bo'lishi kerak";
  }
  const lower = password.toLowerCase();
  if (
    COMMON_PASSWORDS.has(lower) ||
    isSingleCharRepeat(lower) ||
    isSequential(lower)
  ) {
    return 'Parol juda oddiy — boshqa parol tanlang';
  }
  const phoneDigits = String(context.phone ?? '').replace(/\D/g, '');
  const passwordDigits = password.replace(/\D/g, '');
  if (
    phoneDigits.length >= 7 &&
    passwordDigits.length === password.length &&
    (phoneDigits.endsWith(passwordDigits) ||
      passwordDigits.endsWith(phoneDigits.slice(-9)))
  ) {
    return "Parol telefon raqami bo'lmasligi kerak";
  }
  return null;
}

/** Parol oqimi kalitlari (`PASSWORD_CHANGE_GATE` …): `on`/`true`/`1`/`yes`. */
export function isPasswordSwitchOn(raw: unknown): boolean {
  const value =
    typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'boolean'
      ? String(raw)
      : '';
  return ['on', 'true', '1', 'yes'].includes(value.trim().toLowerCase());
}

/** `passwordPolicyError(...) === null`. */
export function isPasswordPolicyCompliant(
  password: unknown,
  context: PasswordPolicyContext = {},
): boolean {
  return passwordPolicyError(password, context) === null;
}

/**
 * DTO dekoratori. `role` — qat'iy rol (masalan, `Roles.COURIER`) yoki
 * `(dto) => rol` (DTO'dagi `role` maydonidan). Qoida hamma rolga bir xil;
 * identity-service xeshlashdan oldin baribir o'zi ham tekshiradi.
 * Bo'sh/berilmagan qiymat — `@IsOptional` / `@IsNotEmpty` ishi.
 */
export function IsPasswordPolicy(
  role?: string | ((dto: Record<string, unknown>) => string | null | undefined),
  options?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isPasswordPolicy',
      target: target.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          return (
            passwordPolicyError(value, {
              role: resolveDecoratorRole(role, args),
            }) === null
          );
        },
        defaultMessage(args: ValidationArguments) {
          return (
            passwordPolicyError(args.value, {
              role: resolveDecoratorRole(role, args),
            }) ?? 'Parol siyosatga mos emas'
          );
        },
      },
    });
  };
}

function resolveDecoratorRole(
  role:
    | string
    | ((dto: Record<string, unknown>) => string | null | undefined)
    | undefined,
  args: ValidationArguments,
): string | null {
  if (typeof role === 'function') {
    return role(args.object as Record<string, unknown>) ?? null;
  }
  return role ?? null;
}
