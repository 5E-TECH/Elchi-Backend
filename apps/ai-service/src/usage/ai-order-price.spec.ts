import type { ConfigService } from '@nestjs/config';
import {
  DEFAULT_AI_PRICE_PER_ORDER_UZS,
  effectiveAiOrderPriceUzs,
  globalAiOrderPriceUzs,
  priceOrNull,
} from './ai-order-price';

/**
 * NFiXfmq6 — AI buyurtma narxi: global default 300 (env), market kesimida
 * ustun qiymat (null → global, 0 → bepul).
 */
const cfg = (values: Record<string, unknown>) =>
  ({ get: (key: string): unknown => values[key] }) as unknown as ConfigService;

describe('NFiXfmq6 — AI buyurtma narxi (ai-order-price)', () => {
  describe('global narx (AI_PRICE_PER_ORDER)', () => {
    it('TC: env berilmasa — 300 so‘m', () => {
      expect(DEFAULT_AI_PRICE_PER_ORDER_UZS).toBe(300);
      expect(globalAiOrderPriceUzs(cfg({}))).toBe(300);
    });

    it('TC: env orqali sozlanadi (AI_PRICE_PER_ORDER), satr ham songa aylanadi', () => {
      expect(globalAiOrderPriceUzs(cfg({ AI_PRICE_PER_ORDER: 450 }))).toBe(450);
      expect(globalAiOrderPriceUzs(cfg({ AI_PRICE_PER_ORDER: '275.5' }))).toBe(
        275.5,
      );
    });

    it('AI_PRICE_PER_ORDER berilmasa eski AI_ORDER_PRICE_UZS ishlaydi (mavjud deploy o‘zgarmaydi); ikkalasi bo‘lsa yangisi ustun', () => {
      expect(globalAiOrderPriceUzs(cfg({ AI_ORDER_PRICE_UZS: 200 }))).toBe(200);
      expect(
        globalAiOrderPriceUzs(
          cfg({ AI_PRICE_PER_ORDER: 350, AI_ORDER_PRICE_UZS: 200 }),
        ),
      ).toBe(350);
    });

    it('global 0 — hammaga bepul; yaroqsiz (manfiy/son emas) qiymat e’tiborsiz', () => {
      expect(globalAiOrderPriceUzs(cfg({ AI_PRICE_PER_ORDER: 0 }))).toBe(0);
      expect(globalAiOrderPriceUzs(cfg({ AI_PRICE_PER_ORDER: -5 }))).toBe(300);
      expect(globalAiOrderPriceUzs(cfg({ AI_PRICE_PER_ORDER: 'abc' }))).toBe(
        300,
      );
      expect(globalAiOrderPriceUzs(cfg({ AI_PRICE_PER_ORDER: '' }))).toBe(300);
    });
  });

  describe('market narxi (admins.ai_price_per_order)', () => {
    it('TC: bo‘sh (null/undefined) bo‘lsa global default ishlaydi', () => {
      expect(effectiveAiOrderPriceUzs(null, 300)).toBe(300);
      expect(effectiveAiOrderPriceUzs(undefined, 300)).toBe(300);
      expect(effectiveAiOrderPriceUzs('', 450)).toBe(450);
    });

    it('TC: market qiymati globaldan ustun; 0 — o‘sha market uchun AI bepul', () => {
      expect(effectiveAiOrderPriceUzs(500, 300)).toBe(500);
      expect(effectiveAiOrderPriceUzs('120.456', 300)).toBe(120.46);
      expect(effectiveAiOrderPriceUzs(0, 300)).toBe(0);
    });

    it('manfiy/yaroqsiz market qiymati — global (DB CHECK baribir taqiqlaydi)', () => {
      expect(effectiveAiOrderPriceUzs(-1, 300)).toBe(300);
      expect(effectiveAiOrderPriceUzs('x', 300)).toBe(300);
      expect(priceOrNull(Number.NaN)).toBeNull();
    });
  });
});
