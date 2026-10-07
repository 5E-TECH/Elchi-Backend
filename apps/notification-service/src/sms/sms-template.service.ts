import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SMS_LANGUAGES,
  SmsLanguage,
  SmsTemplate,
} from '../entities/sms-template.entity';
import { SMS_MESSAGE_CLASSES, SmsMessageClass } from './sms.port';
import { countSmsSegments } from './sms-segments.util';
import { asText } from './sms-phone.util';

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * PII MINIMUMI (nkhURiKX #8): SMS'da faqat buyurtma raqami, holat va kerak
 * bo'lsa summa. Mijoz ismi, manzili, mahsulot ro'yxati SMS'ga CHIQMAYDI —
 * ular in-app va Telegram'da qoladi.
 */
export const SMS_FORBIDDEN_VARS = [
  'name',
  'customer_name',
  'first_name',
  'last_name',
  'full_name',
  'address',
  'customer_address',
  'products',
  'product_list',
  'items',
] as const;

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
    const forbidden = required.filter((key) =>
      (SMS_FORBIDDEN_VARS as readonly string[]).includes(key.toLowerCase()),
    );
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
