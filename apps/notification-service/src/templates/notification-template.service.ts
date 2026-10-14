import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { NOTIFICATION_TYPES, findNotificationType } from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import {
  SMS_FORBIDDEN_VARS,
  SmsTemplateError,
  renderSmsTemplate,
  templateVars,
} from '../sms/sms-template.service';
import { countSmsSegments } from '../sms/sms-segments.util';
import {
  NotificationTemplate,
  TEMPLATE_CHANNELS,
  TEMPLATE_LANGUAGES,
  TemplateChannel,
  TemplateLanguage,
} from './notification-template.entity';

/** Fail-closed render xatosi: `required_vars` / matndagi o'zgaruvchi yo'q. */
export class TemplateRenderError extends Error {
  constructor(
    message: string,
    readonly missing: string[],
  ) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

export interface RenderedTemplate {
  title: string;
  body: string | null;
  lang: TemplateLanguage;
  channel: TemplateChannel | null;
  template_id: string;
}

type TemplateRow = Pick<
  NotificationTemplate,
  'id' | 'lang' | 'channel' | 'title' | 'body' | 'required_vars'
>;

const isLanguage = (value: unknown): value is TemplateLanguage =>
  (TEMPLATE_LANGUAGES as readonly string[]).includes(String(value));

const isBlank = (raw: unknown) =>
  raw === undefined ||
  raw === null ||
  (typeof raw === 'string' && !raw.trim()) ||
  (typeof raw === 'object' && !(raw instanceof Date));

/**
 * Bitta shablonni to'ldiradi — FAIL-CLOSED (C4R3YyvH #3): `required_vars`
 * yoki matndagi birorta `{{var}}` `data` da yo'q/bo'sh bo'lsa XATO, bo'sh
 * satr QO'YILMAYDI ("Hurmatli , buyurtmangiz..." chiqmaydi). Naqsh —
 * SMS shablonlaridagi `renderSmsTemplate` (integration-service `interpolate`
 * dagi `{{key}}` sintaksisi; integration-service xulqi O'ZGARTIRILMAGAN).
 */
export function renderTemplate(
  template: Pick<TemplateRow, 'title' | 'body' | 'required_vars'>,
  data: Record<string, unknown>,
): { title: string; body: string | null } {
  const missing = [
    ...new Set([
      ...(template.required_vars ?? []),
      ...templateVars(template.title),
      ...templateVars(template.body ?? ''),
    ]),
  ].filter((key) => isBlank(data[key]));
  if (missing.length) {
    throw new TemplateRenderError(
      `Shablon o'zgaruvchisi to'ldirilmagan: ${missing.join(', ')}`,
      missing,
    );
  }
  try {
    return {
      title: renderSmsTemplate(template.title, data).slice(0, 255),
      body:
        template.body === null || template.body === undefined
          ? null
          : renderSmsTemplate(template.body, data).slice(0, 4096),
    };
  } catch (error) {
    if (error instanceof SmsTemplateError)
      throw new TemplateRenderError(error.message, error.missing);
    throw error;
  }
}

/**
 * Til zanjiri (C4R3YyvH #4): so'ralgan til + kanal → so'ralgan til (umumiy)
 * → 'uz' + kanal → 'uz' (umumiy). Topilmasa — null (chaqiruvchi DTO'dagi
 * xom `title`/`body` ni ishlatadi, dispatch yiqilmaydi).
 */
export function pickTemplate<T extends Pick<TemplateRow, 'lang' | 'channel'>>(
  rows: readonly T[],
  lang: string | null | undefined,
  channel: TemplateChannel | null = null,
): T | null {
  const wanted: TemplateLanguage = isLanguage(lang) ? lang : 'uz';
  const order: Array<[TemplateLanguage, TemplateChannel | null]> = [
    [wanted, channel],
    [wanted, null],
    ['uz', channel],
    ['uz', null],
  ];
  for (const [l, c] of order) {
    const found = rows.find(
      (row) => row.lang === l && (row.channel ?? null) === c,
    );
    if (found) return found;
  }
  return null;
}

/**
 * Katalogdagi HAR tur uchun 'uz' asos shabloni (C4R3YyvH #7 CI testi):
 * sarlavha — katalog yorlig'i (`label_uz`), tana yo'q, o'zgaruvchisiz.
 * ⚠️ Dispatch'da AVTOMATIK QO'LLANMAYDI — chaqiruvchining (order-service,
 * finance, ...) o'z matni o'zgarmasin; admin DB'ga shablon yozgandagina
 * (`PUT /notifications/templates`) matn shablondan olinadi. Ro'yxatda
 * (`GET`) DB'da 'uz' yozuvi yo'q turlar uchun `source: 'default'`.
 */
export function defaultUzTemplates() {
  return NOTIFICATION_TYPES.map((type) => ({
    code: type.key,
    lang: 'uz' as const,
    channel: null,
    title: type.label_uz,
    body: null as string | null,
    required_vars: [] as string[],
    source: 'default' as const,
  }));
}

/** SMS'ga ketadigan matn uchun kodlash/bo'lak (C4R3YyvH DIQQAT a). */
export function templateSmsMeta(title: string, body: string | null) {
  const text = [title, body].filter((part) => part && part.trim()).join(': ');
  const segments = countSmsSegments(text);
  return {
    encoding: segments.encoding,
    parts: segments.parts,
    units: segments.units,
  };
}

const bad = (message: string) => new RpcException({ statusCode: 400, message });

export interface UpsertNotificationTemplateInput {
  code?: unknown;
  lang?: unknown;
  channel?: unknown;
  title?: unknown;
  body?: unknown;
  required_vars?: unknown;
  is_active?: unknown;
  requester?: { id?: string | number | null } | null;
}

type DispatchText = { title: string; body: string | null };

/** Dispatch uchun: qabul qiluvchi → shu tilda tayyor matn (yoki null = xom). */
export interface DispatchTexts {
  textFor: (recipientId: string) => DispatchText | null;
  stats: {
    code: string;
    applied: number;
    fallback_raw: number;
    errors: string[];
    by_lang: Record<string, number>;
  };
}

/**
 * Bildirishnoma shablonlari reyestri (C4R3YyvH): ro'yxat, yozish (admin),
 * render va dispatch uchun til bo'yicha matn.
 */
@Injectable()
export class NotificationTemplateService {
  private readonly logger = new Logger(NotificationTemplateService.name);

  constructor(
    @InjectRepository(NotificationTemplate)
    private readonly repo: Repository<NotificationTemplate>,
  ) {}

  /** `GET /notifications/templates?code&lang` */
  async list(query: { code?: unknown; lang?: unknown } = {}) {
    const where: Record<string, unknown> = { isDeleted: false };
    if (typeof query?.code === 'string' && query.code.trim())
      where.code = query.code.trim();
    if (query?.lang !== undefined && query.lang !== '') {
      if (!isLanguage(query.lang))
        throw bad(`lang: ${TEMPLATE_LANGUAGES.join(', ')}`);
      where.lang = query.lang;
    }
    const rows = await this.repo.find({
      where,
      order: { code: 'ASC', lang: 'ASC', id: 'ASC' },
    });
    const withUz = new Set(
      rows
        .filter((row) => row.lang === 'uz' && row.channel === null)
        .map((row) => row.code),
    );
    const defaults = defaultUzTemplates().filter(
      (item) =>
        !withUz.has(item.code) &&
        (!where.code || item.code === where.code) &&
        (!where.lang || where.lang === 'uz'),
    );
    return successRes(
      {
        items: rows.map((row) => this.toPublic(row)),
        defaults: defaults.map((item) => ({
          ...item,
          ...templateSmsMeta(item.title, item.body),
        })),
        languages: TEMPLATE_LANGUAGES,
        channels: TEMPLATE_CHANNELS,
        forbidden_vars: SMS_FORBIDDEN_VARS,
      },
      200,
      'Notification templates',
    );
  }

  /** `PUT /notifications/templates` — (code, lang, channel) bo'yicha upsert. */
  async upsert(input: UpsertNotificationTemplateInput) {
    const code = typeof input?.code === 'string' ? input.code.trim() : '';
    if (!findNotificationType(code))
      throw bad(
        `code: katalogdagi tur bo'lishi shart (GET /notifications/types) — '${code.slice(0, 64)}'`,
      );
    const lang = input?.lang ?? 'uz';
    if (!isLanguage(lang)) throw bad(`lang: ${TEMPLATE_LANGUAGES.join(', ')}`);
    const rawChannel = input?.channel;
    const channel =
      rawChannel === undefined || rawChannel === null || rawChannel === ''
        ? null
        : rawChannel;
    if (
      channel !== null &&
      (typeof channel !== 'string' ||
        !(TEMPLATE_CHANNELS as readonly string[]).includes(channel))
    )
      throw bad(`channel: null | ${TEMPLATE_CHANNELS.join(', ')}`);
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 255) throw bad('title: 1-255 belgi');
    const body =
      input?.body === undefined || input.body === null
        ? null
        : typeof input.body === 'string'
          ? input.body
          : null;
    if (body !== null && body.length > 4096) throw bad('body: ≤4096 belgi');
    const declared = Array.isArray(input?.required_vars)
      ? input.required_vars.map((v) => String(v).trim()).filter(Boolean)
      : [];
    if (declared.some((v) => !/^[a-zA-Z0-9_]{1,64}$/.test(v)))
      throw bad('required_vars: faqat [a-zA-Z0-9_]');
    const required = [
      ...new Set([
        ...declared,
        ...templateVars(title),
        ...templateVars(body ?? ''),
      ]),
    ];
    // (DIQQAT b) PII minimumi: umumiy shablon (channel=null) SMS'ga ham ketadi
    // (inbox qatori matni = SMS matni) — shuning uchun umumiy va 'sms'
    // shablonlarida mijoz ismi/manzili/mahsulotlari TAQIQLANGAN.
    if (channel === null || channel === 'sms') {
      const forbidden = required.filter((key) =>
        (SMS_FORBIDDEN_VARS as readonly string[]).includes(key.toLowerCase()),
      );
      if (forbidden.length)
        throw bad(
          `SMS'ga ketadigan shablonda shaxsiy ma'lumot taqiqlangan (PII): ${forbidden.join(', ')}`,
        );
    }

    const existing = await this.repo.findOne({
      where: {
        code,
        lang,
        channel: channel === null ? IsNull() : (channel as TemplateChannel),
        isDeleted: false,
      },
    });
    const requester = input?.requester?.id;
    const saved = await this.repo.save(
      this.repo.create({
        ...(existing ?? {}),
        code,
        lang,
        channel: channel as TemplateChannel | null,
        title,
        body,
        required_vars: required,
        is_active:
          typeof input?.is_active === 'boolean'
            ? input.is_active
            : (existing?.is_active ?? true),
        updated_by:
          requester !== undefined &&
          requester !== null &&
          /^\d+$/.test(String(requester))
            ? String(requester)
            : null,
      }),
    );
    return successRes(
      this.toPublic(saved),
      existing ? 200 : 201,
      existing ? 'Template updated' : 'Template created',
    );
  }

  /**
   * `renderTemplate(code, lang, channel, data)` (C4R3YyvH #3/#4): til
   * zanjiri bilan tanlaydi va FAIL-CLOSED to'ldiradi. Shablon yo'q — null.
   */
  async render(
    code: string,
    lang: string | null | undefined,
    channel: TemplateChannel | null,
    data: Record<string, unknown>,
  ): Promise<RenderedTemplate | null> {
    const rows = await this.activeFor(code);
    const template = pickTemplate(rows, lang, channel);
    if (!template) return null;
    const text = renderTemplate(template, data);
    return {
      ...text,
      lang: template.lang,
      channel: template.channel ?? null,
      template_id: String(template.id),
    };
  }

  /**
   * Dispatch (C4R3YyvH #5): tashqi kanallarga ketadigan matn DISPATCH
   * PAYTIDA qabul qiluvchi tilida renderlanadi va inbox qatoriga yoziladi
   * (yuborilgan matn — o'zgarmas dalil). Shablon yo'q → null (xom DTO).
   * Render xatosi (o'zgaruvchi yo'q) → o'sha qabul qiluvchiga xom DTO matni
   * (buzuq matn emas), sabab `stats.errors` da.
   *
   * `languagesOf` — faqat 'uz' dan boshqa tildagi shablon bo'lsa chaqiriladi
   * (bitta bulk RPC).
   */
  async forDispatch(
    code: string,
    data: Record<string, unknown>,
    recipientIds: string[],
    languagesOf: (ids: string[]) => Promise<Map<string, string | null>>,
  ): Promise<DispatchTexts | null> {
    if (!recipientIds.length) return null;
    const rows = (await this.activeFor(code)).filter(
      (row) => row.channel === null,
    );
    if (!rows.length) return null;
    let languages = new Map<string, string | null>();
    if (rows.some((row) => row.lang !== 'uz')) {
      try {
        languages = await languagesOf(recipientIds);
      } catch (error) {
        this.logger.warn(
          `shablon: tillar olinmadi, 'uz' ishlatiladi — ${(error as Error)?.message ?? String(error)}`,
        );
      }
    }
    const stats: DispatchTexts['stats'] = {
      code,
      applied: 0,
      fallback_raw: 0,
      errors: [],
      by_lang: {},
    };
    const cache = new Map<TemplateLanguage, DispatchText | null>();
    const textOf = (lang: TemplateLanguage): DispatchText | null => {
      if (cache.has(lang)) return cache.get(lang) ?? null;
      const template = pickTemplate(rows, lang, null);
      let text: DispatchText | null = null;
      if (template) {
        try {
          text = renderTemplate(template, data);
        } catch (error) {
          stats.errors.push(
            `${template.lang}: ${(error as Error).message}`.slice(0, 200),
          );
        }
      }
      cache.set(lang, text);
      return text;
    };
    const byRecipient = new Map<string, DispatchText | null>();
    for (const id of recipientIds) {
      const raw = languages.get(id);
      const lang: TemplateLanguage = isLanguage(raw) ? raw : 'uz';
      const text = textOf(lang);
      byRecipient.set(id, text);
      if (text) {
        stats.applied += 1;
        stats.by_lang[lang] = (stats.by_lang[lang] ?? 0) + 1;
      } else stats.fallback_raw += 1;
    }
    return { textFor: (id) => byRecipient.get(id) ?? null, stats };
  }

  private activeFor(code: string) {
    return this.repo.find({
      where: {
        code,
        is_active: true,
        isDeleted: false,
        lang: In([...TEMPLATE_LANGUAGES]),
      },
      order: { id: 'ASC' },
    });
  }

  private toPublic(row: NotificationTemplate) {
    return {
      id: row.id,
      code: row.code,
      lang: row.lang,
      channel: row.channel ?? null,
      title: row.title,
      body: row.body,
      required_vars: row.required_vars ?? [],
      is_active: row.is_active,
      updated_by: row.updated_by ?? null,
      updated_at: row.updatedAt,
      source: 'db' as const,
      // (DIQQAT a) 1 SMS = 160 lotin (GSM-7) yoki 70 kirill (UCS-2) belgi.
      ...templateSmsMeta(row.title, row.body),
    };
  }
}
