import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_EXTRACT_IMAGES_PER_CHUNK,
  AI_MAX_IMAGES,
  AI_MAX_ITEMS_PER_ORDER,
  AI_MAX_ORDERS_PER_PARSE,
  AI_MODEL_DEFAULTS,
  ClaudeService,
  maskPhones,
  unmaskPhones,
  type AiOrderExtractRequest,
  type AiOrderExtractResponse,
  type ClaudeImageInput,
  type ClaudeResult,
  type RawOrderExtraction,
} from '@app/common';
import {
  AI_IMAGE_STORE,
  AiImageStore,
  isAiImageKeyFor,
} from '@app/common/ai/ai-image-store';
import { AiDraftService } from '../draft/ai-draft.service';
import {
  ORDER_EXTRACT_PROMPT_VERSION,
  ORDER_EXTRACT_SYSTEM,
} from '../prompts/order-extract.prompt';
import { ORDER_EXTRACT_SCHEMA } from '../prompts/order-extract.schema';
import { supportsEffort } from '../usage/ai-pricing';
import { mergeExtractedOrders } from './merge-orders';
import { sanitizeExtraction } from './sanitize-extraction';

/**
 * WHMAIqyo #1: max_tokens buyurtmalar soniga qarab — `1500 + 600 × N`,
 * chegara 16 000 (ilgari doim 32 000). `effort:'low'` bilan thinking qisqa;
 * baribir kesilsa ClaudeService BIR marta 2x byudjet bilan qayta uradi.
 */
export const ORDER_EXTRACT_BASE_TOKENS = 1_500;
export const ORDER_EXTRACT_TOKENS_PER_ORDER = 600;
export const ORDER_EXTRACT_MAX_TOKENS = 16_000;
/** Bitta rasmda o'rtacha nechta buyurtma bo'lishi mumkin (taxmin, yuqoriga). */
export const ORDER_EXTRACT_ORDERS_PER_IMAGE = 3;
/**
 * WHMAIqyo #1: ekstraksiya `output_config.effort` — `low` (thinking qisqa,
 * javob tezroq). Sonnet 5 da effort qo'llanadi (thinking sukut bo'yicha
 * adaptive, `thinking` kaliti BERILMAYDI). Butun yo'nalish uchun QAT'IY —
 * so'rovdan so'rovga o'zgarmaydi (effort o'zgarishi prompt keshini buzadi).
 * Faqat `AI_LOW_EFFORT_MODELS` dagi modelga yuboriladi (district-pick bilan
 * bitta ro'yxat): Haiku 4.5 kabi effort'siz model 400 olmasin.
 */
export const ORDER_EXTRACT_EFFORT = 'low' as const;

const LIST_MARKER_RE = /^\s*(?:\d{1,2}[.)]|[-•*])\s+\S/gm;

/**
 * Matndagi (va rasmlardagi) kutilgan buyurtmalar soni — YUQORIGA taxmin
 * (kam baholash javobni kesadi, ko'p baholash faqat byudjet): telefon
 * tokenlari soni, ro'yxat belgilari (1. / 2) / -) va bo'sh qator bilan
 * ajratilgan bloklarning eng kattasi; har rasmga 3 tadan.
 */
export function estimateOrderCount(
  maskedText: string,
  phoneTokenCount: number,
  imageCount: number,
): number {
  const text = maskedText.trim();
  const listItems = text ? (text.match(LIST_MARKER_RE) ?? []).length : 0;
  const blocks = text
    ? text.split(/\n\s*\n/).filter((b) => b.trim() !== '').length
    : 0;
  const fromText = text ? Math.max(1, phoneTokenCount, listItems, blocks) : 0;
  const fromImages = Math.max(0, imageCount) * ORDER_EXTRACT_ORDERS_PER_IMAGE;
  const total = Math.max(1, fromText + fromImages);
  return Math.min(total, AI_MAX_ORDERS_PER_PARSE);
}

/** `1500 + 600 × N`, chegara 16 000. */
export function orderExtractMaxTokens(expectedOrders: number): number {
  const n = Math.max(1, Math.floor(expectedOrders));
  return Math.min(
    ORDER_EXTRACT_MAX_TOKENS,
    ORDER_EXTRACT_BASE_TOKENS + ORDER_EXTRACT_TOKENS_PER_ORDER * n,
  );
}

/** Rasmlarni `size` tadan bo'laklarga bo'ladi (tartib saqlanadi). */
export function chunkImages<T>(images: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let i = 0; i < images.length; i += step) {
    chunks.push(images.slice(i, i + step));
  }
  return chunks;
}

type ExtractCallResult = ClaudeResult<{ orders: unknown[] }>;
type ExtractFailure = Exclude<ExtractCallResult, { ok: true }>;

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
 *
 * WHMAIqyo #4: 5 tadan ko'p rasm bo'lsa rasmlar 5 tadan bo'laklarga bo'linib
 * PARALLEL ekstraksiya qilinadi (matn faqat 1-bo'lakka qo'shiladi — matndagi
 * buyurtma ikki marta chiqmasin), natijalar birlashtiriladi va dublikat
 * buyurtmalar olib tashlanadi (`mergeExtractedOrders`). Bitta bo'lak ham
 * muvaffaqiyatsiz bo'lsa — butun parse muvaffaqiyatsiz (yarim natija
 * operatorga "hammasi o'qildi" deb ko'rinmasin).
 */
@Injectable()
export class OrderExtractService {
  private readonly logger = new Logger(OrderExtractService.name);

  constructor(
    private readonly claude: ClaudeService,
    private readonly config: ConfigService,
    // vncdmXOy: audit izi (ai_order_draft). Ixtiyoriy — berilmasa (spec)
    // ekstraksiya o'zgarishsiz ishlaydi.
    @Optional() private readonly drafts?: AiDraftService,
    // WHMAIqyo #3: `image_refs` (MinIO kalitlari) uchun vaqtinchalik saqlov.
    @Optional()
    @Inject(AI_IMAGE_STORE)
    private readonly imageStore?: AiImageStore | null,
  ) {}

  /**
   * Rasm manbai: `image_refs` bo'lsa saqlovdan o'qiladi va DARHOL o'chiriladi
   * (fire-and-forget); aks holda `images` (base64). Kalit faqat shu draft'ning
   * `ai-tmp/` yo'li bo'lishi shart — boshqa obyektni o'qib bo'lmaydi.
   * null — rasmni olib bo'lmadi (chaqiruvchi `ai_error` qaytaradi).
   */
  private async resolveImages(
    req: AiOrderExtractRequest,
  ): Promise<AiOrderExtractRequest['images'] | null> {
    const refs = Array.isArray(req.image_refs) ? req.image_refs : [];
    if (refs.length === 0) return Array.isArray(req.images) ? req.images : [];
    const draftId = typeof req.draft_id === 'string' ? req.draft_id : '';
    const valid =
      refs.length <= AI_MAX_IMAGES &&
      refs.every((ref) => isAiImageKeyFor(draftId, ref));
    if (!this.imageStore || !valid) {
      this.logger.warn(
        `ai_extract_image_refs_rejected store=${!!this.imageStore} ` +
          `valid=${valid} count=${refs.length}`,
      );
      return null;
    }
    try {
      return await this.imageStore.getAll(refs);
    } catch (err) {
      this.logger.warn(
        `ai_extract_image_fetch_failed: ${
          err instanceof Error ? err.name : 'unknown'
        }`,
      );
      return null;
    } finally {
      // Rasm RAM'ga o'qildi (yoki o'qilmadi) — saqlovda qoldirilmaydi.
      void this.imageStore.deleteAll(refs);
    }
  }

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
    const sourceImages = await this.resolveImages(req);
    if (sourceImages === null) return { ok: false, reason: 'ai_error' };
    const images: ClaudeImageInput[] = (sourceImages ?? []).map((img) => ({
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
    // maskalanadi va javob shu servis ichida qaytariladi. Rasm RAM'da;
    // WHMAIqyo #3: gateway uni MinIO'ga ko'pi bilan 1 soatga (TTL) qo'yadi,
    // shu yerda o'qilgach darhol o'chiriladi; bazaga YOZILMAYDI. Matn, rasm
    // va natija buyurtmalari HECH QACHON logga chiqmaydi (jurnalga faqat
    // uzunlik va sha256).
    const { masked, tokens } = maskPhones(text);
    // Faqat rasm bo'lsa o'ram bo'sh qoladi — "rasmdan o'qing" kabi qo'shimcha
    // gap qo'shilmaydi (rasm yo'riqnomasi system-prompt'da, kesh buzilmaydi).
    const userText = masked;

    const model = hasImages
      ? this.model('AI_ORDER_VISION_MODEL')
      : this.model('AI_ORDER_MODEL');

    // Bo'laklar: rasmsiz — bitta (faqat matn); rasm bilan — 5 tadan, matn
    // faqat 1-bo'lakda.
    const imageChunks = hasImages
      ? chunkImages(images, AI_EXTRACT_IMAGES_PER_CHUNK)
      : [[]];
    const calls = imageChunks.map((chunkImagesList, i) => {
      const chunkText = i === 0 ? userText : '';
      const expected = estimateOrderCount(
        chunkText,
        i === 0 ? tokens.size : 0,
        chunkImagesList.length,
      );
      return this.claude.extractJson<{ orders: unknown[] }>({
        system: ORDER_EXTRACT_SYSTEM,
        userText: chunkText,
        schema: ORDER_EXTRACT_SCHEMA,
        model,
        maxTokens: orderExtractMaxTokens(expected),
        ...(supportsEffort(model) ? { effort: ORDER_EXTRACT_EFFORT } : {}),
        images: chunkImagesList,
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
    });
    const results: ExtractCallResult[] = await Promise.all(calls);

    const failure = results.find((r): r is ExtractFailure => !r.ok) ?? null;
    const okResults = results.filter(
      (r): r is Extract<ExtractCallResult, { ok: true }> => r.ok,
    );
    const anyCalled = results.some((r) => r.ok || r.attempts > 0);
    // Xom chiqish (unmask'dan OLDIN) — bo'laklar tartibida birlashtirilgan.
    const rawOrders: unknown[] = okResults.flatMap((r) =>
      Array.isArray(r.data?.orders) ? r.data.orders : [],
    );

    // vncdmXOy: audit izi — Claude'ga AYNAN ketgan maskalangan matn, asl
    // matn+rasm xeshi (rasmning o'zi YO'Q), model, prompt versiyasi va LLM xom
    // chiqishi ([TEL_n] tokenlari bilan, unmask'dan OLDIN). WHMAIqyo #1:
    // FIRE-AND-FORGET — javob audit yozuvini KUTMAYDI (recordExtraction hech
    // qachon reject qilmaydi; gateway attach_preview'i qatordan oldin kelib
    // qolsa ai-draft.service qayta urinadi). AI chaqirilmagan holat
    // ('disabled' — kalit yo'q / shift) yozilmaydi.
    if (anyCalled) {
      void this.drafts?.recordExtraction({
        draftId: req.draft_id,
        marketId: req.market_id,
        userId: req.requester?.id,
        traceId: req.trace_id,
        maskedText: userText,
        originalText: text,
        imagesBase64: images.map((img) => img.dataBase64),
        model: okResults[0]?.model ?? model,
        promptVersion: ORDER_EXTRACT_PROMPT_VERSION,
        outcome: failure ? failure.reason : 'ok',
        rawExtraction: failure ? null : { orders: rawOrders },
      });
    }

    if (failure) {
      if (imageChunks.length > 1) {
        this.logger.warn(
          `ai_extract_chunk_failed chunks=${imageChunks.length} ` +
            `failed=${results.filter((r) => !r.ok).length} reason=${failure.reason}`,
        );
      }
      if (failure.reason === 'cap_exceeded') {
        return {
          ok: false,
          reason: 'cap_exceeded',
          scope: failure.scope,
          reset_at: failure.reset_at,
        };
      }
      return { ok: false, reason: failure.reason };
    }

    // Tokenlar faqat MATNLI 1-bo'lakka tegishli: rasm-faqat bo'lakda model
    // `[TEL_n]` ni o'ylab topsa, u matndagi raqamga aylanmasin (null bo'ladi).
    const noTokens = new Map<string, string>();
    const perChunk: RawOrderExtraction[][] = okResults.map((r, i) =>
      sanitizeExtraction(unmaskPhones(r.data, i === 0 ? tokens : noTokens)),
    );
    const orders =
      perChunk.length === 1 ? perChunk[0] : mergeExtractedOrders(perChunk);

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
