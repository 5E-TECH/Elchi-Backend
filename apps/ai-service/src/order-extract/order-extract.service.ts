import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_MAX_ITEMS_PER_ORDER,
  AI_MAX_ORDERS_PER_PARSE,
  AI_MODEL_DEFAULTS,
  ClaudeService,
  maskPhones,
  unmaskPhones,
  type AiOrderExtractRequest,
  type AiOrderExtractResponse,
  type ClaudeImageInput,
} from '@app/common';
import { ORDER_EXTRACT_SYSTEM } from '../prompts/order-extract.prompt';
import { ORDER_EXTRACT_SCHEMA } from '../prompts/order-extract.schema';
import { sanitizeExtraction } from './sanitize-extraction';

/**
 * Ekstraksiya uchun max_tokens. Sonnet 5 da thinking sukut bo'yicha yoqiq va
 * u ham shu byudjetdan yeydi; ko'p buyurtmali (30 tagacha) JSON kesilmasin.
 */
export const ORDER_EXTRACT_MAX_TOKENS = 32000;

/**
 * `ai.order.extract` — erkin matn va/yoki rasmdan buyurtma(lar)ni ajratadi.
 *
 * Yagona yo'l (bVeyEuIR #11): DOIM ko'p-buyurtma sxemasi va bitta prompt;
 * BeePost'dagi bitta-buyurtma yo'li (alohida feature, sukut 1024 max_tokens,
 * sinalmagan) ko'chirilmagan — single-path.guard.spec.ts buni qulflaydi.
 *
 * Oqim: telefonlar `[TEL_n]` bilan maskalanadi → Claude (faqat nom va
 * raqamlar, ID YO'Q) → tokenlar ai-service ICHIDA qaytariladi → sanitize
 * (oq ro'yxat, narx/enum/operator darvozalari, axlat filtri) → chegaralar.
 * Tokenlar hech qachon ai-service'dan tashqariga chiqmaydi.
 */
@Injectable()
export class OrderExtractService {
  private readonly logger = new Logger(OrderExtractService.name);

  constructor(
    private readonly claude: ClaudeService,
    private readonly config: ConfigService,
  ) {}

  private model(key: 'AI_ORDER_MODEL' | 'AI_ORDER_VISION_MODEL'): string {
    const raw = this.config.get<unknown>(key);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value) return value;
    return key === 'AI_ORDER_VISION_MODEL'
      ? AI_MODEL_DEFAULTS.vision
      : AI_MODEL_DEFAULTS.order;
  }

  async extract(
    req: AiOrderExtractRequest,
    deadlineAt?: number,
  ): Promise<AiOrderExtractResponse> {
    const images: ClaudeImageInput[] = (
      Array.isArray(req.images) ? req.images : []
    ).map((img) => ({
      mediaType: img.media_type,
      dataBase64: img.data_base64,
    }));
    const hasImages = images.length > 0;
    const text = typeof req.text === 'string' ? req.text.trim() : '';

    // Bo'sh so'rov (matn ham, rasm ham yo'q) — pulli chaqiruvning ma'nosi yo'q.
    // Gateway buni 400 bilan to'xtatadi; bu faqat himoya to'ri.
    if (!hasImages && text === '') return { ok: true, orders: [] };

    // ⚠️ MAXFIYLIK (HD5zOyBp): quyidagi userText mijoz PII'sini (ism, manzil)
    // o'z ichiga oladi va Anthropic (AQSh) API'ga yuboriladi (ega 2026-09-19
    // da ruxsat bergan). Telefonlar KETISHDAN OLDIN `[TEL_n]` bilan
    // maskalanadi va javob shu servis ichida qaytariladi. Rasm faqat RAM'da —
    // diskka/MinIO'ga/bazaga YOZILMAYDI. Matn, rasm va natija buyurtmalari
    // HECH QACHON logga chiqmaydi (jurnalga faqat uzunlik va sha256).
    const { masked, tokens } = maskPhones(text);
    // Faqat rasm bo'lsa o'ram bo'sh qoladi — "rasmdan o'qing" kabi qo'shimcha
    // gap qo'shilmaydi (rasm yo'riqnomasi system-prompt'da, kesh buzilmaydi).
    const userText = masked;

    const r = await this.claude.extractJson<{ orders: unknown[] }>({
      system: ORDER_EXTRACT_SYSTEM,
      userText,
      schema: ORDER_EXTRACT_SCHEMA,
      model: hasImages
        ? this.model('AI_ORDER_VISION_MODEL')
        : this.model('AI_ORDER_MODEL'),
      maxTokens: ORDER_EXTRACT_MAX_TOKENS,
      images,
      deadlineAt,
      meta: {
        feature: hasImages ? 'order_extract_image' : 'order_extract_multi',
        requestArea: 'order',
        marketId: req.market_id ?? null,
        userId: req.requester?.id ?? null,
        traceId: req.trace_id ?? null,
        draftId: req.draft_id ?? null,
      },
    });

    if (!r.ok) {
      if (r.reason === 'cap_exceeded') {
        return {
          ok: false,
          reason: 'cap_exceeded',
          scope: r.scope,
          reset_at: r.reset_at,
        };
      }
      return { ok: false, reason: r.reason };
    }

    const orders = sanitizeExtraction(unmaskPhones(r.data, tokens));

    // ⚠️ Chegaradan oshgan natija UI'ga berilmaydi: ai-confirm DTO baribir
    // rad etadi (30 buyurtma / 50 qator). Operator matnni bo'lib yuboradi.
    const tooManyItems = orders.some(
      (o) => o.items.length > AI_MAX_ITEMS_PER_ORDER,
    );
    if (orders.length > AI_MAX_ORDERS_PER_PARSE || tooManyItems) {
      this.logger.warn(
        `ai_extract_over_limit orders=${orders.length} ` +
          `max_orders=${AI_MAX_ORDERS_PER_PARSE} ` +
          `items_over_limit=${tooManyItems} — 'truncated' qaytarildi`,
      );
      return { ok: false, reason: 'truncated' };
    }

    return { ok: true, orders };
  }
}
