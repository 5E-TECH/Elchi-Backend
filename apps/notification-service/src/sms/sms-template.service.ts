import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SMS_LANGUAGES,
  SmsLanguage,
  SmsTemplate,
} from '../entities/sms-template.entity';
import { SMS_MESSAGE_CLASSES, SmsMessageClass } from './sms.port';
import { countSmsSegments, nonGsm7Chars } from './sms-segments.util';
import { asText } from './sms-phone.util';

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * PII MINIMUMI (nkhURiKX #8): SMS'da faqat buyurtma raqami, holat va kerak
 * bo'lsa summa. Mijoz ismi, manzili, mahsulot ro'yxati SMS'ga CHIQMAYDI —
 * ular in-app va Telegram'da qoladi.
 *
 * Aniq ro'yxat + naqshlar (`isPiiVar`): `client_name`, `recipient_address`,
 * `product_names` kabi variantlar ham ushlanadi. Do'kon/filial nomi
 * (`market_name`, `branch_name`) mijoz PII si emas — ruxsat.
 */
export const SMS_FORBIDDEN_VARS = [
  'name',
  'customer_name',
  'first_name',
  'last_name',
  'full_name',
  'fio',
  'ism',
  'familiya',
  'address',
  'customer_address',
  'manzil',
  'products',
  'product_list',
  'product_names',
  'items',
  'order_items',
  'goods',
  'mahsulotlar',
  'tovarlar',
] as const;

const PII_VAR_PATTERNS: readonly RegExp[] = [
  // Mijoz / qabul qiluvchi ismi yoki manzili (customer_full_name, client_address...).
  /^(customer|client|receiver|recipient|buyer|mijoz)_(.*_)?(name|fio|ism|familiya|address|manzil)$/,
  // Mahsulot ro'yxati (products_list, item_names, mahsulot_nomlari...).
  /^(products?|items?|order_items|goods|mahsulot(lar)?|tovar(lar)?)(_(list|names?|text|nomlari|royxati))?$/,
];

/** O'zgaruvchi nomi mijoz PII si (ism/manzil/mahsulotlar) bo'lsa true. */
export const isPiiVar = (key: string): boolean => {
  const normalized = String(key ?? '')
    .trim()
    .toLowerCase();
  return (
    (SMS_FORBIDDEN_VARS as readonly string[]).includes(normalized) ||
    PII_VAR_PATTERNS.some((pattern) => pattern.test(normalized))
  );
};

/** Ro'yxatdagi PII o'zgaruvchilar (takrorsiz, tartib saqlanadi). */
export const piiVars = (keys: readonly string[]): string[] => [
  ...new Set(keys.filter(isPiiVar)),
];

export class SmsTemplateError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = 'SmsTemplateError';
  }
}

export const templateVars = (text: string): string[] => [
  ...new Set(Array.from(text.matchAll(VAR_RE), (match) => match[1])),
];

/**
 * `{{var}}` larni to'ldiradi. `required` dagi BIROR kalit bo'sh/yo'q bo'lsa
 * XATO (fail-closed) — "Hurmatli , buyurtmangiz..." kabi buzuq matn pulga
 * yuborilmaydi. Matndagi har qanday to'ldirilmagan o'zgaruvchi ham xato.
 */
export function renderSmsTemplate(
  text: string,
  vars: Record<string, unknown>,
  required: string[] = [],
): string {
  const value = (key: string) => {
    const raw = vars[key];
    return asText(raw).trim();
  };
  const missing = [...new Set([...required, ...templateVars(text)])].filter(
    (key) => !value(key),
  );
  if (missing.length) {
    throw new SmsTemplateError(
      `Shablon o'zgaruvchisi to'ldirilmagan: ${missing.join(', ')}`,
      missing,
    );
  }
  return text.replace(VAR_RE, (_, key: string) => value(key));
}

/** Shablon matni chegarasi (gateway DTO bilan bir xil). */
export const SMS_TEMPLATE_MAX_LENGTH = 1000;

export interface SmsTextPreviewInput {
  text?: unknown;
  message_class?: unknown;
  required_vars?: unknown;
  /** Namuna qiymatlar — berilsa to'ldirilgan matn sanaladi. */
  vars?: unknown;
}

export interface SmsTextPreviewDeps {
  /** Bir bo'lak narxi (so'm), sozlanmagan bo'lsa null. */
  tariff: (messageClass: SmsMessageClass) => number | null;
  /** Reklamaga qo'shiladigan bekor qilish ko'rsatmasi (sozlanmagan → null). */
  appendOptOut?: (text: string) => string | null;
}

/**
 * Muharrir hisoblagichi (nkhURiKX #6) — HECH NARSA yozilmaydi/yuborilmaydi.
 * Bo'lak/kodlash `countSmsSegments` bilan (hisob-kitobdagi AYNI qoida),
 * narx = bo'laklar × tarif. Reklamada bekor qilish havolasi ham hisobga
 * KIRADI (kampaniya prognozi bilan bir xil). `vars` berilsa — namuna
 * qiymatlar bilan to'ldirilgan matn sanaladi; yetishmagani `missing_vars`.
 * PII o'zgaruvchilari `pii_vars` da (saqlashda 400 bo'ladi).
 */
export function previewSmsText(
  input: SmsTextPreviewInput,
  deps: SmsTextPreviewDeps,
) {
  const text = typeof input?.text === 'string' ? input.text : '';
  if (text.length > SMS_TEMPLATE_MAX_LENGTH) {
    throw new SmsTemplateError(
      `text: ${SMS_TEMPLATE_MAX_LENGTH} belgidan oshmasin`,
    );
  }
  const messageClass = (input?.message_class ??
    'transactional') as SmsMessageClass;
  if (!SMS_MESSAGE_CLASSES.includes(messageClass)) {
    throw new SmsTemplateError(
      `message_class: ${SMS_MESSAGE_CLASSES.join(', ')}`,
    );
  }
  const required = Array.isArray(input?.required_vars)
    ? input.required_vars.map((key) => asText(key).trim()).filter(Boolean)
    : [];
  const vars = templateVars(text);
  const sample =
    input?.vars && typeof input.vars === 'object' && !Array.isArray(input.vars)
      ? (input.vars as Record<string, unknown>)
      : null;
  let rendered: string | null = null;
  let missing: string[] = [];
  if (sample) {
    try {
      rendered = renderSmsTemplate(text, sample, required);
    } catch (error) {
      if (!(error instanceof SmsTemplateError)) throw error;
      missing = error.missing;
    }
  }
  const body = rendered ?? text;
  const withOptOut =
    messageClass === 'promo' && body && deps.appendOptOut
      ? deps.appendOptOut(body)
      : null;
  const counted = withOptOut ?? body;
  const segments = countSmsSegments(counted);
  const tariff = deps.tariff(messageClass);
  return {
    message_class: messageClass,
    encoding: segments.encoding,
    units: segments.units,
    parts: segments.parts,
    per_part: segments.perPart,
    non_gsm_chars: nonGsm7Chars(counted),
    opt_out_included: withOptOut !== null,
    vars,
    pii_vars: piiVars([...required, ...vars]),
    missing_vars: missing,
    rendered,
    currency: 'UZS' as const,
    tariff,
    estimated_cost: tariff === null ? null : tariff * segments.parts,
  };
}

export interface UpsertTemplateInput {
  code: string;
  message_class: string;
  lang: string;
  text: string;
  required_vars?: string[];
  is_active?: boolean;
}

/** SMS shablonlari reyestri (nkhURiKX). */
@Injectable()
export class SmsTemplateService {
  private readonly logger = new Logger(SmsTemplateService.name);

  constructor(
    @InjectRepository(SmsTemplate)
    private readonly repo: Repository<SmsTemplate>,
  ) {}

  list() {
    return this.repo.find({ order: { code: 'ASC', lang: 'ASC' } });
  }

  /**
   * Yaratadi yoki yangilaydi. Matn o'zgarsa `provider_template_id` BO'SHATILADI
   * — operator qayta tasdiqlashi kerak.
   */
  async upsert(input: UpsertTemplateInput) {
    const code = String(input.code ?? '').trim();
    const text = String(input.text ?? '');
    if (!/^[a-z0-9_.-]{2,64}$/.test(code)) {
      throw new SmsTemplateError('code: 2-64 belgi, faqat a-z 0-9 _ . -');
    }
    if (!SMS_MESSAGE_CLASSES.includes(input.message_class as SmsMessageClass)) {
      throw new SmsTemplateError(
        `message_class: ${SMS_MESSAGE_CLASSES.join(', ')}`,
      );
    }
    if (!SMS_LANGUAGES.includes(input.lang as SmsLanguage)) {
      throw new SmsTemplateError(`lang: ${SMS_LANGUAGES.join(', ')}`);
    }
    if (!text.trim()) throw new SmsTemplateError("text bo'sh");
    const vars = templateVars(text);
    const required = [...new Set([...(input.required_vars ?? []), ...vars])];
    const forbidden = piiVars(required);
    if (forbidden.length) {
      throw new SmsTemplateError(
        `SMS'da shaxsiy ma'lumot taqiqlangan (PII minimumi): ${forbidden.join(', ')}`,
      );
    }

    const existing = await this.repo.findOne({
      where: { code, lang: input.lang as SmsLanguage },
    });
    const textChanged = !existing || existing.text !== text;
    const saved = await this.repo.save(
      this.repo.create({
        ...(existing ?? {}),
        code,
        lang: input.lang as SmsLanguage,
        message_class: input.message_class as SmsMessageClass,
        text,
        required_vars: required,
        provider_template_id: textChanged
          ? null
          : (existing?.provider_template_id ?? null),
        is_active: input.is_active ?? existing?.is_active ?? true,
      }),
    );
    return this.withMeta(saved);
  }

  /** Operator provayderda tasdiqlagan shablon id'si. */
  async markApproved(id: string, providerTemplateId: string) {
    await this.repo.update(
      { id },
      { provider_template_id: providerTemplateId.trim() || null },
    );
    return this.withMeta(await this.repo.findOneOrFail({ where: { id } }));
  }

  async remove(id: string) {
    const result = await this.repo.delete({ id });
    return { deleted: result.affected ?? 0 };
  }

  /**
   * Tilni tanlash: mijoz tili → bo'lmasa 'uz'. Shablon o'sha tilda topilmasa
   * 'uz' ga fallback va bu LOGGA yoziladi.
   */
  async resolve(
    code: string,
    lang: string | null | undefined,
  ): Promise<SmsTemplate | null> {
    const wanted = SMS_LANGUAGES.includes(lang as SmsLanguage)
      ? (lang as SmsLanguage)
      : 'uz';
    const exact = await this.repo.findOne({
      where: { code, lang: wanted, is_active: true },
    });
    if (exact) return exact;
    if (wanted !== 'uz') {
      const fallback = await this.repo.findOne({
        where: { code, lang: 'uz', is_active: true },
      });
      if (fallback) {
        this.logger.warn(
          `SMS shablon '${code}' '${wanted}' tilida yo'q — 'uz' ga fallback`,
        );
        return fallback;
      }
    }
    return null;
  }

  withMeta(template: SmsTemplate) {
    const segments = countSmsSegments(template.text);
    return {
      ...template,
      encoding: segments.encoding,
      parts: segments.parts,
      needs_provider_approval: !template.provider_template_id,
    };
  }
}
