import { ANTHROPIC_API_KEY_ENV } from './claude.constants';
import type { AnthropicKeyInspection } from './claude.types';

/**
 * "ANTHROPIC" ga o'xshash nom: bitta harf tushgan (ANTROPIC, ANTHOPIC,
 * ANTOPIC) yoki umuman boshqa brend nomi (CLAUDE_API_KEY).
 */
const LOOK_ALIKE_NAME = /ANTH?R?OPIC|CLAUDE/i;
const KEY_HINT = /KEY/i;

/**
 * Env'dagi Anthropic kaliti holatini tekshiradi.
 *
 * ⚠️ NEGA KERAK: Joi sxemasi allowUnknown ochiq (repoda validationOptions
 * berilmagan) — `ANTROPIC_API_KEY` (bitta 'H' tushgan) kabi xato nom bilan
 * servis MUVAFFAQIYATLI ko'tariladi va AI jimgina o'chiq qoladi. Joi bu
 * holatni ko'rmaydi; startdagi aniq WARN — yagona himoya (bVeyEuIR #10).
 *
 * ⚠️ MAXFIYLIK: faqat env NOMLARI qaytadi — qiymat HECH QACHON o'qilib
 * logga yoki javobga chiqmaydi (faqat bo'sh/bo'sh emasligi tekshiriladi).
 *
 * - `ok`       — ANTHROPIC_API_KEY bor va bo'sh emas;
 * - `misnamed` — to'g'ri kalit yo'q/bo'sh, lekin o'xshash nom(lar) bor;
 * - `missing`  — kalit ham, o'xshash nom ham yo'q.
 */
export function inspectAnthropicEnv(
  env: NodeJS.ProcessEnv,
): AnthropicKeyInspection {
  const misnamedKeys = Object.keys(env)
    .filter(
      (name) =>
        name !== ANTHROPIC_API_KEY_ENV &&
        LOOK_ALIKE_NAME.test(name) &&
        KEY_HINT.test(name),
    )
    .sort();

  const raw = env[ANTHROPIC_API_KEY_ENV];
  const hasKey = typeof raw === 'string' && raw.trim() !== '';
  if (hasKey) return { state: 'ok', misnamedKeys };

  return {
    state: misnamedKeys.length > 0 ? 'misnamed' : 'missing',
    misnamedKeys,
  };
}
