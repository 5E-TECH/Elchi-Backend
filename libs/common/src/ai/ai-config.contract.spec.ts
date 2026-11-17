import {
  AI_CONFIG_ERROR_CODES,
  AI_CONFIG_ERROR_STATUS,
  AI_CONFIG_PATTERNS,
  AI_CONFIG_PUBLIC_ERROR_FIELDS,
  AI_CONFIG_WRITE_PATTERNS,
} from './ai-config.contract';
import { isAiConfigCmd } from '../rmq/rmq-requester-signature';
import { PUBLIC_ERROR_CODES } from '../filters/public-error-fields';

/** openapi-fragment v0.2 `AiConfigError.code` enum (FE shu ro'yxatga quradi). */
const FRAGMENT_CODES = [
  'AI_CONFIG_UI_DISABLED',
  'AI_CONFIG_CONFLICT',
  'AI_CONFIG_INVALID',
  'AI_KEY_FORMAT',
  'AI_KEY_ADMIN_KEY',
  'AI_KEY_SAME',
  'AI_KEY_REJECTED',
  'AI_KEY_FORBIDDEN',
  'AI_KEY_BAD_REQUEST',
  'AI_KEY_BILLING',
  'AI_KEY_UPSTREAM_RATE_LIMITED',
  'AI_KEY_VERIFY_UNAVAILABLE',
  'AI_KEY_ATTEMPTS_EXCEEDED',
  'AI_KEY_STORAGE_UNAVAILABLE',
  'AI_KEY_NONE',
  'AI_KEY_NO_PREVIOUS',
  'AI_MODEL_NOT_ALLOWED',
  'AI_MODEL_REASON_REQUIRED',
  'AI_MODEL_CATALOG_UNAVAILABLE',
  'AI_CONFIG_EXPIRED',
  'AI_CONFIG_UNSIGNED',
  'AI_CONFIG_NOT_ALLOWED',
  'AI_STEP_UP_REQUIRED',
  'AI_KEY_OAUTH_TOKEN',
  'AI_KEY_WRAP_STALE',
  'AI_KEY_WRAP_INVALID',
  'AI_MODEL_CAP_RISK',
];

describe('ai-config shartnomasi', () => {
  const codes = Object.values(AI_CONFIG_ERROR_CODES);

  it('kodlar openapi-fragment bilan bir xil', () => {
    expect([...codes].sort()).toEqual([...FRAGMENT_CODES].sort());
  });

  it('hech bir kod 401 emas (FE 401 da sessiyani tugatadi)', () => {
    for (const c of codes) {
      expect(AI_CONFIG_ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
      expect(AI_CONFIG_ERROR_STATUS[c]).not.toBe(401);
    }
  });

  it('har kod PUBLIC_ERROR_CODES da (maydonlar oq ro‘yxati)', () => {
    for (const c of codes) {
      expect(PUBLIC_ERROR_CODES[c]).toEqual(AI_CONFIG_PUBLIC_ERROR_FIELDS[c]);
    }
  });

  it('hamma buyruq ai.config.* (imzo va DLX’siz navbat qoidasi)', () => {
    for (const p of Object.values(AI_CONFIG_PATTERNS)) {
      expect(isAiConfigCmd(p)).toBe(true);
    }
    expect(AI_CONFIG_WRITE_PATTERNS).not.toContain(AI_CONFIG_PATTERNS.GET);
    expect(AI_CONFIG_WRITE_PATTERNS).not.toContain(AI_CONFIG_PATTERNS.HISTORY);
  });
});
