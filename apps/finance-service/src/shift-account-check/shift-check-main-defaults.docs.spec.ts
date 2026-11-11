import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SHIFT_LATE_PHOTO_ERROR_CODES,
  SHIFT_LATE_PHOTO_MESSAGES,
} from '@app/common';
import {
  SHIFT_CHECK_BRANCH_KEY,
  SHIFT_CHECK_MAIN_ON_KEYS,
} from '../../../../migrations/1716000000215-ShiftCheckMainDefaults';
import { FINANCE_REALTIME_EVENTS } from '../realtime/finance-realtime.service';
import { SHIFT_LATE_PHOTO_WINDOW_MS } from './shift-account-check.rules';

/**
 * BE-A — FRONTEND_CHANGELOG yozuvi kod / migratsiya 215 xatti-harakati bilan
 * AJRALMASIN (sharh topilmalari):
 *  • AI `pending` kutishi ~15 s (finance `DEFAULT_CLOSE_WAIT_MS`), 30 s emas;
 *  • MAIN «Asosiy karta» qatori shift settings / yopish / avto-yopishda ham
 *    yaratiladi (bo'sh karta ro'yxati MAIN talabini chetlab o'tmaydi);
 *  • rasm / AI master kalitlari GLOBAL — migratsiya ularni yoqadi, superadmin
 *    bayroq qo'ygan filial kartalari ta'sirlanadi («filialga tegilmaydi» emas);
 *  • eski kod + yangi DB (deploy oralig'i / kodni qaytarish) xavfi va chorasi.
 * BE-B (o'sha kun, keyinroq) yozuvi BE-A dan TEPADA turadi — BE-A esa darhol
 * undan keyin (eng yangisi tepada); BE-B matni ham kod bilan solishtiriladi.
 */
const CHANGELOG = readFileSync(
  join(__dirname, '../../../../docs/frontend/FRONTEND_CHANGELOG.md'),
  'utf8',
);

const BEA_HEADING =
  "### 2026-11-10 — Smena yopish: ASOSIY kassada karta qoldig'i + skrinshot + AI sukut bo'yicha MAJBURIY (BE-A)";
const BEB_HEADING =
  '### 2026-11-10 — Avto-yopilgan ASOSIY kassa smenasiga 24 soat ichida karta rasmini keyin yuklash (BE-B)';

/** Yozuv matni: sarlavhadan keyingi `### ` gacha. */
function entryAfter(heading: string): string {
  const start = CHANGELOG.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = CHANGELOG.slice(start + heading.length);
  // Qatorlar 120 belgida bo'linadi — matn bo'yicha solishtirish uchun bitta qator.
  return rest.slice(0, rest.search(/\n### /)).replace(/\s*\n\s*/g, ' ');
}

/** BE-A yozuvi: sarlavhadan keyingi `### ` gacha. */
const beaEntry = (): string => entryAfter(BEA_HEADING);

/** «Yangi yozuvlar shu yerga» belgisidan keyingi yozuv sarlavhalari (tartib bilan). */
function headingsAfterMarker(): string[] {
  const marker = CHANGELOG.indexOf(
    '<!-- Yangi yozuvlar shu yerga (eng yangisi tepada) -->',
  );
  expect(marker).toBeGreaterThanOrEqual(0);
  return CHANGELOG.slice(marker)
    .split('\n')
    .filter((line) => line.startsWith('### '));
}

describe('BE-A FRONTEND_CHANGELOG ↔ kod (migratsiya 215)', () => {
  const entry = beaEntry();

  it('yozuv «Yangi yozuvlar shu yerga» belgisidan keyin tepada — faqat BE-B (keyingi o‘zgarish) undan yuqorida', () => {
    const [first, second] = headingsAfterMarker();
    // BE-B — BE-A ustiga qurilgan keyingi yozuv (eng yangisi tepada).
    expect(first).toBe(BEB_HEADING);
    expect(second).toBe(BEA_HEADING);
    expect(second).toMatch(/^### 2026-11-10 — Smena yopish: ASOSIY kassada/);
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

describe('BE-B FRONTEND_CHANGELOG ↔ kod (avto-yopilgan smenaga rasmni keyin yuklash)', () => {
  const entry = entryAfter(BEB_HEADING);

  it('endpoint, rollar, migratsiya yo‘q, 24 soatlik oyna', () => {
    expect(SHIFT_LATE_PHOTO_WINDOW_MS).toBe(24 * 3600_000);
    expect(entry).toContain(
      '**`POST /finance/shift/:shift_id/accounts/:card_id/late-photo`** (superadmin, admin;',
    );
    expect(entry).toContain("**Migratsiya YO'Q**");
    expect(entry).toContain('Deploy: finance-service + api-gateway.');
    expect(entry).toContain("`closed_at` + 24 soat o'tgan");
  });

  it('har xato kodi va matni koddagi bilan bir xil', () => {
    const rows: Array<[number, keyof typeof SHIFT_LATE_PHOTO_ERROR_CODES]> = [
      [400, 'MAIN_ONLY'],
      [409, 'NOT_AUTO_CLOSED'],
      [409, 'EXPIRED'],
      [404, 'CARD_NOT_IN_SHIFT'],
    ];
    for (const [status, key] of rows) {
      const code = SHIFT_LATE_PHOTO_ERROR_CODES[key];
      expect(entry).toContain(`| ${status} | \`${code}\``);
      expect(entry).toContain(`\`${SHIFT_LATE_PHOTO_MESSAGES[code]}\``);
    }
  });

  it('hisobot maydonlari va realtime hodisasi (`late: true`)', () => {
    for (const field of [
      "photo_status: 'not_required' | 'uploaded' | 'pending' | 'missing';",
      'late_upload_deadline: string | null;',
      'late_uploaded: boolean;',
      'can_upload_late: boolean;',
    ]) {
      expect(entry).toContain(field);
    }
    expect(FINANCE_REALTIME_EVENTS.shiftAccountChecked).toBe(
      'finance.shift.account_checked',
    );
    expect(entry).toContain(
      `**Realtime \`${FINANCE_REALTIME_EVENTS.shiftAccountChecked}\`**`,
    );
    expect(entry).toContain('**`late: true`**');
    expect(entry).toContain('**`finance.shift_late_photo_uploaded`**');
  });
});
