import type { AiModelPolicy, AiModelVerdict } from '@app/common';
import { AI_MODEL_PRICES, normalizeModelId } from '../usage/ai-pricing';

/**
 * MODEL PASAYTIRISH QULFI (LP3RKvXY #2, TC3).
 *
 * ⚠️ BeePost saboqi: boshida HAMMA chaqiruv Haiku'da edi va ekstraksiya
 * "haqiqiy AI'day ishlamas" edi — geografik inference (tuman → viloyat) va
 * narx arifmetikasi ("donasi 250 ming" × 3) buzilardi. Shuning uchun
 * ekstraksiya (`AI_ORDER_MODEL`, `AI_ORDER_VISION_MODEL`) faqat shu
 * ro'yxatdagi KUCHLI modellarda bo'lishi kerak.
 *
 * Ro'yxatdan tashqari model boot'ni YIQITMAYDI (ega: "boot'da xato emas") —
 * startda ERROR log va `ai.status.model_policy` da `ok:false` (dashboard
 * qizil belgi). Noma'lum nom (xato yozilgan, masalan `claude-sonet-5`) ham
 * shu yerda ushlanadi: narx jadvali uni bilmaydi (`ai_usage_log` eng qimmat
 * tarifda hisoblaydi) va Anthropic 404 qaytaradi.
 *
 * Kalitlar `normalizeModelId` shaklida (`claude-` prefiksi va `-YYYYMMDD`
 * suffiksisiz) — narx jadvali bilan bir xil.
 */
export const AI_STRONG_EXTRACTION_MODELS: ReadonlySet<string> = new Set([
  'sonnet-5',
  'opus-5',
  'fable-5',
]);

/** Narx jadvali (`AI_MODEL_PRICES`) taniydigan model. */
function isKnownModel(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(AI_MODEL_PRICES, key);
}

/** Ekstraksiya modeli: kuchli → ok; narx jadvalida bor, lekin kuchsiz → weak. */
function extractionVerdict(model: string): AiModelVerdict {
  const key = normalizeModelId(model);
  if (AI_STRONG_EXTRACTION_MODELS.has(key)) return 'ok';
  return isKnownModel(key) ? 'weak' : 'unknown';
}

/**
 * Klassifikatsiya modeli (tuman indeksi, mahsulot disambiguation) — arzon
 * model QONUNIY; faqat noma'lum nom tekshiriladi.
 */
function classifyVerdict(model: string): AiModelVerdict {
  return isKnownModel(normalizeModelId(model)) ? 'ok' : 'unknown';
}

/** Sof funksiya — config qiymatlari (sukutlar qo'yilgan holda) beriladi. */
export function evaluateModelPolicy(models: {
  order: string;
  vision: string;
  classify: string;
}): AiModelPolicy {
  const order = extractionVerdict(models.order);
  const vision = extractionVerdict(models.vision);
  const classify = classifyVerdict(models.classify);
  return {
    ok: order === 'ok' && vision === 'ok' && classify === 'ok',
    order,
    vision,
    classify,
  };
}

/**
 * Startdagi ERROR matnlari (faqat model NOMLARI — sir yo'q). Bo'sh massiv —
 * hammasi joyida.
 */
export function modelPolicyProblems(
  models: { order: string; vision: string; classify: string },
  policy: AiModelPolicy,
): string[] {
  const problems: string[] = [];
  const strong = [...AI_STRONG_EXTRACTION_MODELS]
    .map((k) => `claude-${k}`)
    .join(', ');
  const extraction: Array<['order' | 'vision', string]> = [
    ['order', 'AI_ORDER_MODEL'],
    ['vision', 'AI_ORDER_VISION_MODEL'],
  ];
  for (const [slot, env] of extraction) {
    const verdict = policy[slot];
    if (verdict === 'weak') {
      problems.push(
        `ai_model_downgrade ${env}=${models[slot]} — ekstraksiya uchun KUCHSIZ model ` +
          `(geografik inference va narx arifmetikasi buziladi). Ruxsat etilgan: ${strong}`,
      );
    } else if (verdict === 'unknown') {
      problems.push(
        `ai_model_unknown ${env}=${models[slot]} — narx jadvalida yo'q (xato nom?). ` +
          `Ruxsat etilgan: ${strong}`,
      );
    }
  }
  if (policy.classify === 'unknown') {
    problems.push(
      `ai_model_unknown AI_CLASSIFY_MODEL=${models.classify} — narx jadvalida yo'q (xato nom?)`,
    );
  }
  return problems;
}
