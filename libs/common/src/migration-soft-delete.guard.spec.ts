import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MIGRATSIYALAR SOFT-DELETE USTUNINI TO'G'RI NOMLASHI SHART.
 *
 * ⚠️ BU XATO IKKI MARTA TAKRORLANDI (`inbound_deal_refs`,
 * `payment_transactions`) va ikkisida ham NATIJA AYNI: jadval
 * `"isDeleted"` bilan yaratilardi, `BaseEntity` esa `is_deleted` yozardi
 * (`@Column({ name: 'is_deleted' })`), ya'ni HAR BIR INSERT
 * `42703 undefined_column` bilan yiqilardi.
 *
 * Nega hech qanday test ushlamadi:
 *   • `synchronize: false` — TypeORM ustunni o'zi qo'shib xatoni
 *     yashirmaydi;
 *   • unit testlar repozitoriyani mock qiladi, real SQL yo'q;
 *   • migratsiya va entity ORASIDAGI muvofiqlikni tekshiradigan joy
 *     yo'q edi.
 *
 * ⚠️ `createdAt`/`updatedAt` BILAN ARALASHTIRMANG — ularda `name:`
 * yo'q, shuning uchun ular HAQIQATAN camelCase ustunlar. Faqat
 * `isDeleted` qayta nomlangan. Aynan shu assimetriya tuzoqning sababi.
 */
describe('Migratsiyalar: soft-delete ustuni nomi', () => {
  const dir = join(__dirname, '../../../migrations');

  /**
   * ⚠️ YAGONA ISTISNO — TUZATUVCHI migratsiya.
   *
   * `1716000000041` noto'g'ri nomlangan ustunni `RENAME` qiladi, ya'ni u
   * eski nomni ATAYLAB ishlatishi SHART. Uni taqiqlasak, tuzatishning
   * o'zini yozib bo'lmasdi.
   *
   * Ro'yxat qasddan bir elementli: yangi fayl qo'shilsa, uni bu yerga
   * kiritish uchun ochiq sabab yozish kerak bo'ladi.
   */
  const CORRECTIVE = new Set(['1716000000041-FixSoftDeleteColumnName.ts']);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !CORRECTIVE.has(f));

  it('migratsiya papkasi topildi (test soxta emas)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s — SQL ichida `"isDeleted"` YO`Q', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');

    /**
     * Izohlardagi eslatmalarni hisobga olmaymiz — ular aynan bu xato
     * haqida YOZILGAN va ularni taqiqlash foydali hujjatni yo'q qilardi.
     * Shu bois blok va satr izohlari olib tashlanadi.
     */
    const withoutComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(withoutComments).not.toContain('"isDeleted"');
  });

  it('istisno ro`yxatidagi fayl HAQIQATAN mavjud', () => {
    /**
     * Istisno eskirib, fayl nomi o'zgarsa — ro'yxat jimgina ma'nosiz
     * bo'lib qolardi va keyingi xato o'tib ketishi mumkin edi.
     */
    // ⚠️ `expect(value, message)` — VITEST sintaksisi, jest'da ishlamaydi.
    // Yorliq solishtirilayotgan qiymat ichiga qo'shiladi.
    const all = new Set(readdirSync(dir));
    for (const name of CORRECTIVE) {
      expect({ name, mavjud: all.has(name) }).toEqual({ name, mavjud: true });
    }
  });

  it('kamida bitta migratsiya `is_deleted` ni TO`G`RI yozadi', () => {
    /**
     * Yuqoridagi test "hech qaysi fayl soft-delete ustunini yaratmaydi"
     * holatida ham o'tardi — ya'ni hech narsani isbotlamasdi. Bu tekshiruv
     * konvensiyaning haqiqatan ishlatilayotganini qulflaydi.
     */
    const anyCorrect = files.some((f) =>
      readFileSync(join(dir, f), 'utf8').includes('"is_deleted"'),
    );
    expect(anyCorrect).toBe(true);
  });
});
