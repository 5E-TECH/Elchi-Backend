import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

/**
 * (NDmZMzCP) bcrypt narxi 10 → 12. Eski (10) xeshlar ishlashda davom etadi;
 * muvaffaqiyatli login'da `needsRehash` bo'lsa parol 12 bilan qayta
 * xeshlanadi (auth.service `login`).
 */
export const BCRYPT_ROUNDS = 12;

/**
 * Parol bilan kirish YOPIQ bo'lgan hisobning `password` qiymati — buyurtma
 * orqali yaratilgan mijozlar (identity `createCustomer`). bcrypt xeshi emas,
 * shuning uchun hech qaysi parol unga mos kelmaydi: `compare` doim `false`.
 *
 * Ilgari har yangi mijoz uchun ishlatilmaydigan tasodifiy parol bcryptjs
 * (sof JS, narx 12) bilan xeshlanardi — identity jarayonining event loop'i
 * ~0.2–0.3 s band bo'lib, shu jarayondagi gateway sessiya tekshiruvi
 * (`identity.auth.session_state`, 1.5 s timeout) ham kutib qolardi.
 *
 * `password` ustuni NOT NULL — shuning uchun NULL emas, marker.
 */
export const PASSWORD_LOGIN_DISABLED = '!password-login-disabled';

/** `$2a$12$` + 53 belgi — bcryptjs taniydigan xesh shakli. */
const BCRYPT_HASH_RE = /^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/;

export function isBcryptHash(value: unknown): value is string {
  return typeof value === 'string' && BCRYPT_HASH_RE.test(value);
}

/**
 * Noma'lum telefon / nofaol foydalanuvchi uchun solishtiriladigan soxta xesh
 * (timing: javob vaqti telefon mavjudligini oshkor qilmasin). Bir marta,
 * birinchi kerak bo'lganda hisoblanadi — haqiqiy xesh bilan AYNI narxda.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash(
    `elchi-timing-dummy-${Math.random()}`,
    BCRYPT_ROUNDS,
  );
  return dummyHashPromise;
}

@Injectable()
export class BcryptEncryption {
  async encrypt(password: string) {
    try {
      return await bcrypt.hash(password, BCRYPT_ROUNDS);
    } catch (error) {
      throw new BadRequestException(`Error on encrypt: ${error}`);
    }
  }

  async compare(password: string, hash: string) {
    // bcrypt bo'lmagan qiymat (`PASSWORD_LOGIN_DISABLED` va h.k.) — bcryptjs
    // darhol `false` qaytarardi; javob vaqti esa telefon ortida parolsiz
    // mijoz turganini oshkor qilardi. Soxta xesh bilan AYNI narxda `false`.
    if (typeof hash === 'string' && !isBcryptHash(hash)) {
      return this.compareDummy(password);
    }
    try {
      return await bcrypt.compare(password, hash);
    } catch (error) {
      throw new BadRequestException(`Error on decrypt: ${error}`);
    }
  }

  /**
   * Natija har doim `false`, lekin vaqt haqiqiy `compare` bilan bir xil —
   * foydalanuvchi topilmaganda yoki nofaol bo'lganda chaqiriladi.
   */
  async compareDummy(password: string): Promise<false> {
    try {
      await bcrypt.compare(String(password ?? ''), await dummyHash());
    } catch {
      // timing uchun — natija ahamiyatsiz
    }
    return false;
  }

  /** Xesh narxi joriydan past (yoki o'qib bo'lmaydi) — qayta xeshlash kerak. */
  needsRehash(hash: string | null | undefined): boolean {
    if (!hash) return false;
    try {
      return bcrypt.getRounds(hash) < BCRYPT_ROUNDS;
    } catch {
      return false;
    }
  }
}
