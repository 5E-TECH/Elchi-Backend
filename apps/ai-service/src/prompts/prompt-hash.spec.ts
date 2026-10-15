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
 * yangi hash shu yerga yoziladi, ORDER_EXTRACT_PROMPT_VERSION oshiriladi va
 * `scripts/ai-extract-eval.ts` jonli eval'i (ega roziligi bilan) qayta
 * o'tkaziladi. Tasodifiy o'zgarish bo'lsa — qaytaring.
 */
const LOCKED = {
  ORDER_EXTRACT_PROMPT_VERSION: '2026-09-27.1',
  ORDER_EXTRACT_SYSTEM:
    '33988f408097a6f30b4148f03125f20403029dfa983166fc98616620d3ea8492',
  ORDER_EXTRACT_SCHEMA:
    '38e2f7424c7da20bf8282df186bcda6ba6879313d68d298ca0f46536aa583ea2',
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
