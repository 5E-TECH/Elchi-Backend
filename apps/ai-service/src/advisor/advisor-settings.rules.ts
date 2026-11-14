import {
  AI_ADVISOR_ERROR_CODES,
  AI_ADVISOR_RULE_KEYS,
  AI_ADVISOR_RULE_LIMITS,
  AI_ADVISOR_RULE_SEVERITY,
  aiAdvisorDefaultRules,
  type AiAdvisorRuleKey,
  type AiAdvisorRulesSettings,
} from '@app/common';
import { advisorError } from './advisor-errors';

/**
 * BE-5 — `settings.rules` ning sof (DB'siz) mantig'i: saqlangan qiymatni
 * sukutlar bilan birlashtirish va PATCH tekshiruvi (§7.7). Hammasi yoki hech
 * narsa: birinchi xatoda throw, natija faqat to'liq to'g'ri bo'lsa.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const RULE_KEYS = new Set<string>(AI_ADVISOR_RULE_KEYS);
/** Top-level PATCH kalitlari. `telegram/budget/schedule` — BE-1 egasi. */
const PATCH_KEYS = new Set([
  'version',
  'rules',
  'telegram',
  'budget',
  'schedule',
]);
const NOT_YET_OWNED = ['telegram', 'budget', 'schedule'] as const;

const invalidSetting = (field: string, message: string) =>
  advisorError(400, AI_ADVISOR_ERROR_CODES.INVALID_SETTING, message, { field });

/**
 * Saqlangan `value` (eski/qisman bo'lishi mumkin) → to'liq qoidalar:
 * sukutlar ustiga faqat tanilgan va to'g'ri turdagi qiymatlar. `severity`
 * saqlanmaydi — doim qotirilgan (Q1).
 */
export function effectiveRules(stored: unknown): AiAdvisorRulesSettings {
  const rules = aiAdvisorDefaultRules();
  if (!isRecord(stored)) return rules;
  for (const key of AI_ADVISOR_RULE_KEYS) {
    const saved = stored[key];
    if (!isRecord(saved)) continue;
    const rule = rules[key];
    if (typeof saved.enabled === 'boolean') rule.enabled = saved.enabled;
    if (typeof saved.telegram === 'boolean') rule.telegram = saved.telegram;
    for (const [field, limit] of Object.entries(AI_ADVISOR_RULE_LIMITS[key])) {
      const v = saved[field];
      if (
        typeof v === 'number' &&
        Number.isFinite(v) &&
        v >= limit.min &&
        v <= limit.max
      ) {
        rule[field] = v;
      }
    }
    rule.severity = AI_ADVISOR_RULE_SEVERITY[key];
  }
  return rules;
}

export interface AdvisorSettingChange {
  field: string;
  old: unknown;
  new: unknown;
}

export interface ParsedSettingsPatch {
  version: number;
  rules: AiAdvisorRulesSettings;
  changes: AdvisorSettingChange[];
}

function stepOk(value: number, step: number): boolean {
  if (step >= 1) return Number.isInteger(value);
  const scaled = value / step;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9;
}

/**
 * PATCH tanasini tekshiradi va joriy qoidalarga qo'llaydi.
 *
 * - `version` yo'q / butun son emas → 400 INVALID_SETTING `version`;
 * - noma'lum kalit (top, qoida, maydon) → 400 INVALID_SETTING `field`;
 * - `telegram`/`budget`/`schedule` (BE-1 kelguncha) → 400 INVALID_SETTING;
 * - `severity` (Q1 — tanlanmaydi) → 400 INVALID_SETTING;
 * - `enabled`/`telegram` boolean emas → 400 INVALID_SETTING;
 * - chegara son emas / oraliqdan tashqarida / qadamga mos emas →
 *   400 INVALID_RULE `{field, min, max}`.
 */
export function parseSettingsPatch(
  patch: unknown,
  current: AiAdvisorRulesSettings,
): ParsedSettingsPatch {
  if (!isRecord(patch)) {
    throw invalidSetting('version', 'Sozlamalar versiyasi yuborilmadi');
  }
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) {
      throw invalidSetting(key, `Noma'lum sozlama: ${key.slice(0, 64)}`);
    }
  }
  const version = patch.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw invalidSetting('version', 'Sozlamalar versiyasi yuborilmadi');
  }
  for (const key of NOT_YET_OWNED) {
    if (patch[key] !== undefined && patch[key] !== null) {
      throw invalidSetting(key, "Bu sozlamani hozircha o'zgartirib bo'lmaydi");
    }
  }

  const next = structuredClone(current);
  const changes: AdvisorSettingChange[] = [];
  const rulesPatch = patch.rules;
  if (rulesPatch !== undefined && rulesPatch !== null) {
    if (!isRecord(rulesPatch)) {
      throw invalidSetting('rules', "Qoidalar obyekt bo'lishi kerak");
    }
    for (const [ruleKey, rulePatch] of Object.entries(rulesPatch)) {
      const base = `rules.${ruleKey.slice(0, 16)}`;
      if (!RULE_KEYS.has(ruleKey)) {
        throw invalidSetting(base, "Noma'lum qoida");
      }
      if (!isRecord(rulePatch)) {
        throw invalidSetting(base, "Qoida sozlamasi obyekt bo'lishi kerak");
      }
      const key = ruleKey as AiAdvisorRuleKey;
      const limits = AI_ADVISOR_RULE_LIMITS[key];
      for (const [field, value] of Object.entries(rulePatch)) {
        const path = `${base}.${field.slice(0, 64)}`;
        if (field === 'severity') {
          throw invalidSetting(path, "Qoida darajasini o'zgartirib bo'lmaydi");
        }
        if (field === 'enabled' || field === 'telegram') {
          if (typeof value !== 'boolean') {
            throw invalidSetting(path, "Qiymat true yoki false bo'lishi kerak");
          }
        } else {
          const limit = Object.hasOwn(limits, field)
            ? limits[field]
            : undefined;
          if (!limit) throw invalidSetting(path, "Noma'lum maydon");
          if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value < limit.min ||
            value > limit.max ||
            !stepOk(value, limit.step)
          ) {
            throw advisorError(
              400,
              AI_ADVISOR_ERROR_CODES.INVALID_RULE,
              limit.step >= 1
                ? `Qiymat ${limit.min} dan ${limit.max} gacha butun son bo'lsin`
                : `Qiymat ${limit.min} dan ${limit.max} gacha bo'lsin (qadam ${limit.step})`,
              { field: path, min: limit.min, max: limit.max },
            );
          }
        }
        const old = next[key][field];
        if (old !== value) {
          next[key][field] = value;
          changes.push({ field: path, old, new: value });
        }
      }
    }
  }
  return { version, rules: next, changes };
}

/** Audit uchun: `[{field: 'rules.R1.x', old, new}]` → `{R1: {x: old}}`. */
export function changesToAudit(changes: AdvisorSettingChange[]): {
  old_value: Record<string, Record<string, unknown>>;
  new_value: Record<string, Record<string, unknown>>;
} {
  const oldValue: Record<string, Record<string, unknown>> = {};
  const newValue: Record<string, Record<string, unknown>> = {};
  for (const c of changes) {
    const [, rule, field] = c.field.split('.');
    (oldValue[rule] ??= {})[field] = c.old;
    (newValue[rule] ??= {})[field] = c.new;
  }
  return { old_value: oldValue, new_value: newValue };
}
