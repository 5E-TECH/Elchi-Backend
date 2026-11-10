import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SHIFT_CHECK_BRANCH_KEY,
  SHIFT_CHECK_MAIN_ON_KEYS,
} from '../../../../migrations/1716000000215-ShiftCheckMainDefaults';

/**
 * BE-A — FRONTEND_CHANGELOG yozuvi kod / migratsiya 215 xatti-harakati bilan
 * AJRALMASIN (sharh topilmalari):
 *  • AI `pending` kutishi ~15 s (finance `DEFAULT_CLOSE_WAIT_MS`), 30 s emas;
 *  • MAIN «Asosiy karta» qatori shift settings / yopish / avto-yopishda ham
 *    yaratiladi (bo'sh karta ro'yxati MAIN talabini chetlab o'tmaydi);
 *  • rasm / AI master kalitlari GLOBAL — migratsiya ularni yoqadi, superadmin
 *    bayroq qo'ygan filial kartalari ta'sirlanadi («filialga tegilmaydi» emas);
 *  • eski kod + yangi DB (deploy oralig'i / kodni qaytarish) xavfi va chorasi.
 */
const CHANGELOG = readFileSync(
  join(__dirname, '../../../../docs/frontend/FRONTEND_CHANGELOG.md'),
  'utf8',
);

/** BE-A yozuvi: sarlavhadan keyingi `### ` gacha. */
function beaEntry(): string {
  const heading =
    "### 2026-11-10 — Smena yopish: ASOSIY kassada karta qoldig'i + skrinshot + AI sukut bo'yicha MAJBURIY (BE-A)";
  const start = CHANGELOG.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = CHANGELOG.slice(start + heading.length);
  // Qatorlar 120 belgida bo'linadi — matn bo'yicha solishtirish uchun bitta qator.
  return rest.slice(0, rest.search(/\n### /)).replace(/\s*\n\s*/g, ' ');
}

describe('BE-A FRONTEND_CHANGELOG ↔ kod (migratsiya 215)', () => {
  const entry = beaEntry();

  it('yozuv «Yangi yozuvlar shu yerga» belgisidan keyin eng tepada', () => {
    const marker = CHANGELOG.indexOf(
      '<!-- Yangi yozuvlar shu yerga (eng yangisi tepada) -->',
    );
    expect(marker).toBeGreaterThanOrEqual(0);
    const firstEntry = CHANGELOG.indexOf('\n### ', marker);
    expect(CHANGELOG.slice(firstEntry + 1)).toMatch(
      /^### 2026-11-10 — Smena yopish: ASOSIY kassada/,
    );
  });

  it('AI pending kutishi ~15 s (30 s emas)', () => {
    expect(entry).toContain('yopish ~15 s kutadi');
    expect(entry).not.toMatch(/30 s gacha kutadi/);
  });

  it('MAIN «Asosiy karta» qatori settings / yopish / avto-yopishda ham yaratiladi', () => {
    expect(entry).not.toContain(
      'birinchi `GET /finance/cashbox/cards` da yaratilsa',
    );
    expect(entry).toContain(
      "`GET /finance/shift/settings` (`cashbox_user_id='0'`), MAIN smenasini yopish yoki avto-yopishda yaratiladi",
    );
    expect(entry).toContain("`Har karta qoldig'ini tasdiqlang: Asosiy karta`");
  });

  it('rasm / AI master kalitlari global — filial kartalari ta’siri ochiq yozilgan', () => {
    // Migratsiya 215 ikkala master kalitni ham yoqadi — ogohlantirish shu
    // sababli shart (kalitlar ro'yxati o'zgarsa — matn qayta ko'rib chiqilsin).
    expect([...SHIFT_CHECK_MAIN_ON_KEYS]).toEqual(
      expect.arrayContaining([
        'shift.photo.required',
        'shift.ai_check.enabled',
      ]),
    );
    expect(entry).not.toContain('Filial kartalariga tegilmaydi');
    expect(entry).toContain(
      'Rasm / AI master kalitlari GLOBAL va migratsiya 215 ularni yoqadi',
    );
    expect(entry).toContain(
      "Filial kartalarining bayroqlari o'zgarmaydi, lekin rasm / AI master kalitlari global",
    );
    expect(entry).toContain(
      "`cards[].photo_required` / `ai_enabled` true bo'lishi mumkin",
    );
  });

  it('eski kod + yangi DB (deploy oralig‘i / kodni qaytarish) xavfi va chorasi', () => {
    // Eski kod `shift.account_check.enabled` ni HAMMA kassaga qo'llaydi,
    // migratsiya esa uni `true` qiladi.
    expect(SHIFT_CHECK_MAIN_ON_KEYS).toContain('shift.account_check.enabled');
    expect(SHIFT_CHECK_BRANCH_KEY).toBe('shift.account_check.branch_enabled');
    expect(entry).toContain('⚠️ **Eski kod + yangi DB**');
    expect(entry).toContain("deploy.yml `rollback()` DB'ni qaytarmaydi");
    expect(entry).toContain('`npm run migration:revert`');
    expect(entry).toContain(
      '`PATCH /finance/shift/settings { account_check_enabled: false }`',
    );
  });
});
