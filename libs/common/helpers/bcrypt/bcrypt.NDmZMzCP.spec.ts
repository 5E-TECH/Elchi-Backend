import * as bcrypt from 'bcryptjs';
import {
  BCRYPT_ROUNDS,
  BcryptEncryption,
  isBcryptHash,
  PASSWORD_LOGIN_DISABLED,
} from './index';

/** (NDmZMzCP) bcrypt narxi 12, eski xeshni aniqlash, timing uchun soxta xesh. */
describe('NDmZMzCP — BcryptEncryption', () => {
  const service = new BcryptEncryption();

  it('yangi xesh 12 narxda; eski (10) xesh ham tekshiriladi', async () => {
    expect(BCRYPT_ROUNDS).toBe(12);
    const hash = await service.encrypt('Kuchli-Parol-2026');
    expect(bcrypt.getRounds(hash)).toBe(12);
    expect(service.needsRehash(hash)).toBe(false);

    const legacy = bcrypt.hashSync('0990', 4);
    expect(await service.compare('0990', legacy)).toBe(true);
    expect(service.needsRehash(legacy)).toBe(true);
  });

  it('needsRehash: bo‘sh yoki bcrypt bo‘lmagan qiymat — false (xato emas)', () => {
    expect(service.needsRehash(null)).toBe(false);
    expect(service.needsRehash('')).toBe(false);
    expect(service.needsRehash('not-a-hash')).toBe(false);
  });

  it('PASSWORD_LOGIN_DISABLED: bcrypt xeshi emas, compare soxta xesh bilan false', async () => {
    expect(isBcryptHash(PASSWORD_LOGIN_DISABLED)).toBe(false);
    expect(isBcryptHash(bcrypt.hashSync('x', 4))).toBe(true);
    expect(isBcryptHash(null)).toBe(false);

    const dummy = jest.spyOn(service, 'compareDummy');
    try {
      await expect(
        service.compare('istalgan', PASSWORD_LOGIN_DISABLED),
      ).resolves.toBe(false);
      // Timing: javob tezda qaytmaydi — soxta xesh bilan AYNI narxdagi bcrypt.
      expect(dummy).toHaveBeenCalledWith('istalgan');
    } finally {
      dummy.mockRestore();
    }
  });

  it('compareDummy har doim false, xato tashlamaydi', async () => {
    await expect(service.compareDummy('istalgan')).resolves.toBe(false);
    await expect(
      service.compareDummy(undefined as unknown as string),
    ).resolves.toBe(false);
  });
});
