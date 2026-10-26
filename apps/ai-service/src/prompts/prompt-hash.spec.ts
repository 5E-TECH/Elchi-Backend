import { createHash } from 'node:crypto';
import {
  ORDER_EXTRACT_PROMPT_VERSION,
  ORDER_EXTRACT_SYSTEM,
} from './order-extract.prompt';
import { ORDER_EXTRACT_SCHEMA } from './order-extract.schema';
import {
  DISTRICT_PICK_CATALOG_SYSTEM,
  DISTRICT_PICK_SYSTEM,
} from './district-pick.prompt';
import { DISTRICT_PICK_SCHEMA } from './district-pick.schema';
import { PRODUCT_DISAMBIG_SYSTEM } from './product-disambiguate.prompt';
import { PRODUCT_DISAMBIG_SCHEMA } from './product-disambiguate.schema';

/**
 * PROMPT KESH QULFI (cSUBv0tY #9).
 *
 * ⚠️ Anthropic prompt keshi PREFIKS bo'yicha, BAYTMA-BAYT ishlaydi: system
 * matnida bitta bo'sh joy yoki bitta harf o'zgarsa ham eski kesh yozuvi
 * ishlamay qoladi — kesh qaytadan yoziladi (input × 1.25), matn chaqiruvdan
 * chaqiruvga o'zgarsa esa (dinamik qiymat) kesh HECH QACHON ishlamaydi
 * (xarajat ~4x). JSON sxema (kalit tartibi ham) o'zgarsa structured-output
 * grammatikasi qaytadan kompilyatsiya qilinadi (birinchi chaqiruvlar sekin).
 * Shuning uchun quyidagi sha256 qiymatlari QO'LDA qulflangan.
 *
 * Bu test qizarsa: o'zgarish ATAYLAB bo'lsa, u ALOHIDA karta bilan qilinadi —
 * yangi hash shu yerga yoziladi, ORDER_EXTRACT_PROMPT_VERSION oshiriladi,
 * `npm run ai:eval -- --ci` (replay, CI) o'tadi va jonli eval
 * (`npm run ai:eval -- --live --yes --record`, ega roziligi bilan) qayta
 * yoziladi. Tasodifiy o'zgarish bo'lsa — qaytaring.
 */
const LOCKED = {
  // J3hEDtFN (2026-10-26.1): xato to'plami qoidalari, 8-misol, anyOf
  // nullable, warnings[].
  ORDER_EXTRACT_PROMPT_VERSION: '2026-10-26.1',
  ORDER_EXTRACT_SYSTEM:
    'c749e7ae493a2c61135334bbab354f63b070b1437c1638f8d243c950e811ffa2',
  ORDER_EXTRACT_SCHEMA:
    '45777b5c1fbedb1491ff65a3243f3dd25eb403dc8f920d6573622183f0b3a8e8',
  PRODUCT_DISAMBIG_SYSTEM:
    'c2d12f1d7e514955261fa657725871a73c1b416d30aa8b4ad0ca1677ad5be4ab',
  PRODUCT_DISAMBIG_SCHEMA:
    '370b4539e409c0753b6b506185b5c59be7695f890f7cdc292d3baae708d5fb6b',
  // 5Z1ZvvzE — tuman LLM fallback'i.
  DISTRICT_PICK_SYSTEM:
    'a92075508a9d691639f8cb301310301304dc260bea8d4047a0c6a997f2706628',
  DISTRICT_PICK_SCHEMA:
    '370b4539e409c0753b6b506185b5c59be7695f890f7cdc292d3baae708d5fb6b',
  // 5Z1ZvvzE TC9 — KATALOG rejimi (tuman ro'yxati system'da, keshlanadi).
  // Ro'yxat qatorlari bu matn OXIRIGA deterministik qo'shiladi.
  DISTRICT_PICK_CATALOG_SYSTEM:
    '58ec03dac4dd5d4e5d8fe7199bed2ac3691e81ca706024efcb2fb8c7c27aecc7',
} as const;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe("prompt/sxema sha256 qulfi (cSUBv0tY #9 — kesh buzilishini erta ko'rsatadi)", () => {
  it('ORDER_EXTRACT_SYSTEM', () => {
    expect(sha256(ORDER_EXTRACT_SYSTEM)).toBe(LOCKED.ORDER_EXTRACT_SYSTEM);
  });

  it('JSON.stringify(ORDER_EXTRACT_SCHEMA)', () => {
    expect(sha256(JSON.stringify(ORDER_EXTRACT_SCHEMA))).toBe(
      LOCKED.ORDER_EXTRACT_SCHEMA,
    );
  });

  it('PRODUCT_DISAMBIG_SYSTEM', () => {
    expect(sha256(PRODUCT_DISAMBIG_SYSTEM)).toBe(
      LOCKED.PRODUCT_DISAMBIG_SYSTEM,
    );
  });

  it('JSON.stringify(PRODUCT_DISAMBIG_SCHEMA)', () => {
    expect(sha256(JSON.stringify(PRODUCT_DISAMBIG_SCHEMA))).toBe(
      LOCKED.PRODUCT_DISAMBIG_SCHEMA,
    );
  });

  it('DISTRICT_PICK_SYSTEM (5Z1ZvvzE)', () => {
    expect(sha256(DISTRICT_PICK_SYSTEM)).toBe(LOCKED.DISTRICT_PICK_SYSTEM);
  });

  it('DISTRICT_PICK_CATALOG_SYSTEM (5Z1ZvvzE TC9 — kesh rejimi)', () => {
    expect(sha256(DISTRICT_PICK_CATALOG_SYSTEM)).toBe(
      LOCKED.DISTRICT_PICK_CATALOG_SYSTEM,
    );
  });

  it('JSON.stringify(DISTRICT_PICK_SCHEMA) (5Z1ZvvzE)', () => {
    expect(sha256(JSON.stringify(DISTRICT_PICK_SCHEMA))).toBe(
      LOCKED.DISTRICT_PICK_SCHEMA,
    );
  });

  it('prompt versiyasi hash bilan birga qulflangan', () => {
    expect(ORDER_EXTRACT_PROMPT_VERSION).toBe(
      LOCKED.ORDER_EXTRACT_PROMPT_VERSION,
    );
  });
});
