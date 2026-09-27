import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  AI_MIN_BUDGET_MS,
  rmqSend,
  type AiProductDisambiguateRequest,
  type AiProductDisambiguateResponse,
} from '@app/common';

/**
 * Noaniq mahsulotlarni LLM bilan aniqlashtirish PORTI (luv25zlI).
 *
 * order-service `@anthropic-ai/sdk` ni HECH QACHON import qilmaydi — LLM'ga
 * faqat RMQ `ai.product.disambiguate` orqali (ai-service) boradi. Port
 * `ProductResolverService` ni transportdan ajratadi: testda spy/Noop, prodda
 * `RmqProductDisambiguator`.
 */
export const PRODUCT_DISAMBIGUATOR = Symbol('PRODUCT_DISAMBIGUATOR');

/** Model tanlovi: `item_index` → 1-asosli katalog indeksi (`choice`, 0 = mos yo'q). */
export interface ProductDisambiguationPicks {
  picks: { item_index: number; choice: number }[];
}

export interface ProductDisambiguator {
  /**
   * `null` — AI ishlamadi (o'chiq, limit, tarmoq, muddat tugadi). Chaqiruvchi
   * itemlarni `unresolved` qoldiradi; oqim YIQILMAYDI.
   *
   * ⚠️ Javob ISHONCHSIZ ma'lumot: diapazon, egalik va raqam tekshiruvi
   * chaqiruvchida (`ProductResolverService`) bajariladi.
   */
  pick(
    req: AiProductDisambiguateRequest,
  ): Promise<ProductDisambiguationPicks | null>;
}

/** LLM'siz variant — hamma noaniq item operatorga qoladi. */
export class NoopProductDisambiguator implements ProductDisambiguator {
  pick(): Promise<ProductDisambiguationPicks | null> {
    return Promise.resolve(null);
  }
}

/** ai-service navbati uchun maksimal RPC kutish (ms). */
const DISAMBIGUATE_MAX_TIMEOUT_MS = 15_000;
/** Umumiy muddatdan zaxira: javob gateway'ga ulgurishi uchun (ms). */
const DISAMBIGUATE_DEADLINE_RESERVE_MS = 1_000;

/**
 * `ai.product.disambiguate` RMQ adapteri.
 *
 * ⚠️ `retries: 0` — MAJBURIY. `rmqSend` sukut bo'yicha timeout'da qayta
 * yuboradi (retries 2), lekin kechikkan birinchi so'rov ai-service'da baribir
 * bajariladi — har qayta urinish Anthropic'ni YANA chaqiradi va pul ikki-uch
 * marta yechiladi. `ai-rpc-no-retry.guard.spec.ts` shu literalni statik
 * tekshiradi — naqsh va `retries: 0` chaqiruv ICHIDA literal bo'lib qolsin.
 *
 * Muddat: `deadline_at` gacha `AI_MIN_BUDGET_MS` dan kam qolgan bo'lsa AI
 * umuman chaqirilmaydi (gateway javobni baribir kutmaydi — faqat pul ketadi).
 */
@Injectable()
export class RmqProductDisambiguator implements ProductDisambiguator {
  private readonly logger = new Logger(RmqProductDisambiguator.name);

  constructor(@Inject('AI') private readonly aiClient: ClientProxy) {}

  async pick(
    req: AiProductDisambiguateRequest,
  ): Promise<ProductDisambiguationPicks | null> {
    const left = Number(req?.deadline_at) - Date.now();
    if (!Number.isFinite(left) || left < AI_MIN_BUDGET_MS) {
      this.logger.warn(
        `ai.product.disambiguate o'tkazib yuborildi — muddat yetarli emas (${Number.isFinite(left) ? left : 'NaN'} ms)`,
      );
      return null;
    }

    try {
      const res = await rmqSend<AiProductDisambiguateResponse>(
        this.aiClient,
        { cmd: 'ai.product.disambiguate' },
        req,
        {
          timeoutMs: Math.min(
            DISAMBIGUATE_MAX_TIMEOUT_MS,
            req.deadline_at - Date.now() - DISAMBIGUATE_DEADLINE_RESERVE_MS,
          ),
          retries: 0,
        },
      );
      if (res?.ok === true && Array.isArray(res.picks)) {
        return { picks: res.picks };
      }
      this.logger.warn(
        `ai.product.disambiguate natijasiz: ${res?.ok === false ? String(res.reason) : "noto'g'ri javob"}`,
      );
      return null;
    } catch (err) {
      this.logger.warn(
        `ai.product.disambiguate xato: ${(err as Error)?.message ?? 'unknown'}`,
      );
      return null;
    }
  }
}
