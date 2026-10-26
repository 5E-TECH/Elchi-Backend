import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

/**
 * (NDmZMzCP) bcrypt narxi 10 → 12. Eski (10) xeshlar ishlashda davom etadi;
 * muvaffaqiyatli login'da `needsRehash` bo'lsa parol 12 bilan qayta
 * xeshlanadi (auth.service `login`).
 */
export const BCRYPT_ROUNDS = 12;

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
