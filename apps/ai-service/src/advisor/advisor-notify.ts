import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AI_ADVISOR_RULE_NAMES,
  NotificationCategory,
  NotificationPriority,
  WEB_ROUTES,
  cabinetBaseUrl,
  deterministicUuid,
  rmqSend,
  type AiAdvisorRuleKey,
  type AiAdvisorRulesSettings,
} from '@app/common';
import { AdvisorSettingsService } from './advisor-settings.service';
import { formatDay, formatRatio, formatSom, r7Sentence } from './advisor-text';

/**
 * BE-5 (LhTIno57) — `ai.advisor_alert` bildirishnomasi (§9.1–9.3).
 *
 * - FAQAT `critical`, ogohlantirish OCHILGANDA BIR MARTA (takrorda, epizod
 *   ichida yo'q; qaytgan muammo — yangi qator → yangi xabar).
 * - Nishon — aniq `recipient_ids` (faol superadminlar, IDENTITY), `roles`
 *   EMAS: aks holda ochiq ilovaga faqat signal boradi va toast chiqmaydi.
 * - Kanallar doim aniq: `in_app` + `realtime`, `telegram` faqat
 *   `settings.telegram.enabled` (BE-1 bo'lguncha — yoqiq) VA
 *   `rules.<R>.telegram` (R7 sukuti — false, Q2 c).
 * - `notified_at` faqat dispatch javobidan KEYIN; xato bo'lsa keyingi tick
 *   ayni `client_request_id` bilan qayta yuboradi — notification-service
 *   takrorni yubormaydi (`duplicate: true`). Xato yutilmaydi-yo'qolmaydi.
 * - Matnda AI matni va PII yo'q (karta — faqat `*_last4`, ism yo'q).
 */
export const ADVISOR_NOTIFY_TYPE = 'ai.advisor_alert';
export const ADVISOR_NOTIFY_BATCH = 20;
export const ADVISOR_RECIPIENTS_TTL_MS = 5 * 60_000;
const BODY_MAX = 600;

export interface AdvisorNotifyRow {
  id: string;
  rule_key: AiAdvisorRuleKey;
  severity: string;
  title: string;
  facts: Record<string, unknown>;
  subject: Record<string, unknown> | null;
  branch: Record<string, unknown> | null;
}

export interface AdvisorDispatchPayload {
  type: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  recipient_ids: string[];
  channels: string[];
  title: string;
  body: string;
  link: string;
  group_key: string;
  client_request_id: string;
  data: Record<string, unknown>;
}

const nameOf = (ref: unknown, fallback: string): string => {
  const r = ref as { name?: unknown; id?: unknown } | null | undefined;
  if (r && typeof r.name === 'string' && r.name.trim()) return r.name.trim();
  if (r && (typeof r.id === 'string' || typeof r.id === 'number'))
    return `#${String(r.id)}`;
  return fallback;
};
const som = (v: unknown) => `${formatSom(Number(v))} so'm`;

/** Sarlavhadagi qisqa nom: R7 — varianti bo'yicha, qolganlari — qoida nomi. */
export function advisorShortName(
  rule: AiAdvisorRuleKey,
  facts: Record<string, unknown>,
): string {
  if (rule === 'R7')
    return facts.source === 'card_balance'
      ? "Karta qoldig'ida farq"
      : 'Chekda farq bor';
  return AI_ADVISOR_RULE_NAMES[rule] ?? rule;
}

/** `body` (§9.3 shablonlari): faqat qoida faktlari, AI matnisiz, PII'siz. */
export function advisorNotifyBody(
  rule: AiAdvisorRuleKey,
  f: Record<string, unknown>,
): string {
  let body: string;
  switch (rule) {
    case 'R1':
      body =
        f.trigger === 'consecutive_negative'
          ? `${nameOf(f.cashbox, 'Kassa')}: ${Number(f.shifts_count)} smena ketma-ket kamomad, jami ${som(f.total_difference)}.`
          : `${nameOf(f.cashbox, 'Kassa')}: smena kamomadi ${som(f.last_difference)}${
              Array.isArray(f.closed_by) && f.closed_by.length
                ? ` (${nameOf(f.closed_by[0], '')})`
                : ''
            }.`;
      break;
    case 'R2':
      body =
        f.trigger === 'growth'
          ? `${nameOf(f.courier, 'Kuryer')}: ${som(f.balance)} — qarz ${Number(f.growth_days)} kun ketma-ket o'sgan.`
          : `${nameOf(f.courier, 'Kuryer')}: ${som(f.balance)}, ${Number(f.days_without_handover)} kundan beri topshirilmagan.`;
      break;
    case 'R3': {
      const ratio = formatRatio(f.ratio_to_median);
      body = `${nameOf(f.branch ?? f.cashbox, 'Kassa')} · ${nameOf(f.category, 'xarajat')}: ${som(f.amount)}${
        ratio ? ` — odatdagidan ${ratio} barobar` : ''
      }.`;
      break;
    }
    case 'R4':
      body = `${nameOf(f.market, 'Market')}: ${Number(f.days_without_payout)} kundan beri to'lov yo'q, qarz ${som(f.debt)}.`;
      break;
    case 'R5':
      body = `${nameOf(f.branch, 'Filial')} kassasida ${som(f.balance)} — HQ'ga ${Number(f.days_without_transfer)} kundan beri o'tkazma yo'q.`;
      break;
    case 'R6':
      body =
        f.period === 'week'
          ? `${formatDay(f.from)}–${formatDay(f.to)} haftasida sof foyda ${som(f.net)}.`
          : `${formatDay(f.from)} kuni sof foyda ${som(f.net)}.`;
      break;
    case 'R7':
      // Sarlavha bilan bitta manba (valyuta, karta, o'tkazma — #653 review).
      body = `${r7Sentence(f)}.`;
      break;
    case 'R8': {
      const ratio = formatRatio(f.ratio);
      body = `${formatDay(f.from)}–${formatDay(f.to)}: ${Number(f.count)} ta tuzatish${
        ratio ? ` — 30 kunlik o'rtachadan ${ratio} barobar` : ''
      }.`;
      break;
    }
    default:
      body = '';
  }
  return body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1)}…` : body;
}

/**
 * Dispatch yuki (§9.3). Oluvchi yo'q — `null` (yuborilmaydi, keyingi tick).
 * `telegramEnabled` — `settings.telegram.enabled` (null → yoqiq).
 */
export function buildAdvisorDispatch(
  row: AdvisorNotifyRow,
  input: {
    recipients: string[];
    rules: AiAdvisorRulesSettings;
    telegramEnabled: boolean;
    cabinetUrl?: string | null;
  },
): AdvisorDispatchPayload | null {
  const recipients = [
    ...new Set(input.recipients.filter((id) => /^\d{1,18}$/.test(id))),
  ];
  if (!recipients.length) return null;
  const facts = row.facts ?? {};
  const channels = ['in_app', 'realtime'];
  if (input.telegramEnabled && input.rules[row.rule_key]?.telegram !== false)
    channels.push('telegram');
  const link = `${WEB_ROUTES.aiAssistant}?tab=alerts&alert=${row.id}`;
  const variant =
    row.rule_key === 'R7'
      ? facts.source === 'card_balance'
        ? 'card_balance'
        : 'receipt'
      : null;
  const subjectName = nameOf(row.branch, '') || nameOf(row.subject, '') || null;
  return {
    type: ADVISOR_NOTIFY_TYPE,
    category: NotificationCategory.FINANCE,
    priority: NotificationPriority.CRITICAL,
    recipient_ids: recipients,
    channels,
    title: `Jiddiy ogohlantirish · ${advisorShortName(row.rule_key, facts)}`,
    body: advisorNotifyBody(row.rule_key, facts) || row.title,
    link,
    group_key: `ai.advisor_alert:${row.id}`,
    client_request_id: deterministicUuid(`ai-advisor-alert:${row.id}`),
    data: {
      alert_id: row.id,
      rule_key: row.rule_key,
      severity: row.severity,
      variant,
      subject_name: subjectName,
      // Faqat https; `telegram_cabinet_link` QO'YILMAYDI (ikkinchi tugma).
      telegram_buttons: [
        [
          {
            text: 'Ogohlantirishni ochish',
            url: `${cabinetBaseUrl(input.cabinetUrl)}${link}`,
          },
        ],
      ],
    },
  };
}

@Injectable()
export class AdvisorNotifier {
  private readonly logger = new Logger(AdvisorNotifier.name);
  private recipientsCache: { ids: string[]; at: number } | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: AdvisorSettingsService,
    @Inject('NOTIFICATION') private readonly notification: ClientProxy,
    @Inject('IDENTITY') private readonly identity: ClientProxy,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** Faol superadminlar (`identity.audience.resolve`), 5 daqiqa kesh. */
  async recipients(now: number = Date.now()): Promise<string[]> {
    if (
      this.recipientsCache &&
      now - this.recipientsCache.at < ADVISOR_RECIPIENTS_TTL_MS
    ) {
      return this.recipientsCache.ids;
    }
    const res = await rmqSend<{ data?: { items?: Array<{ id?: unknown }> } }>(
      this.identity,
      { cmd: 'identity.audience.resolve' },
      {
        roles: ['superadmin'],
        fields: 'minimal',
        limit: 100,
        with_total: false,
      },
      { timeoutMs: 5_000, retries: 1 },
    );
    const ids = (res?.data?.items ?? [])
      .map((i) =>
        typeof i?.id === 'string' || typeof i?.id === 'number'
          ? String(i.id)
          : '',
      )
      .filter((id) => /^\d{1,18}$/.test(id));
    this.recipientsCache = { ids, at: now };
    return ids;
  }

  /**
   * Bildirishnomasi ketmagan ochiq `critical` ogohlantirishlar (yangi ochilgan
   * yoki oldingi urinish yiqilgan). Har biri alohida; xato — keyingi tick.
   */
  async dispatchPending(): Promise<{ sent: number; failed: number }> {
    const out = { sent: 0, failed: 0 };
    const rows = await this.ds.query<AdvisorNotifyRow[]>(
      `SELECT "id"::text AS id, "rule_key", "severity", "title", "facts", "subject", "branch"
         FROM ai_schema.ai_advisor_alerts
        WHERE "severity" = 'critical' AND "status" IN ('new','seen') AND "is_deleted" = false
          AND "notified_at" IS NULL AND "notify_skipped" IS NULL
        ORDER BY "id" LIMIT ${ADVISOR_NOTIFY_BATCH}`,
    );
    if (!rows.length) return out;
    let recipients: string[];
    try {
      recipients = await this.recipients();
    } catch (error) {
      this.logger.warn(
        `ai_advisor_notify: superadminlar olinmadi — ${short(error)}`,
      );
      return { sent: 0, failed: rows.length };
    }
    const rules = await this.settings.getRules();
    const telegramEnabled = await this.settings.telegramEnabled();
    const cabinetUrl = this.config?.get<string>('ELCHI_CABINET_URL') ?? null;
    for (const row of rows) {
      const payload = buildAdvisorDispatch(row, {
        recipients,
        rules,
        telegramEnabled,
        cabinetUrl,
      });
      if (!payload) {
        out.failed += 1;
        continue;
      }
      try {
        await rmqSend(
          this.notification,
          { cmd: 'notification.dispatch' },
          payload,
          {
            timeoutMs: 8_000,
            retries: 0,
          },
        );
        await this.ds.query(
          `UPDATE ai_schema.ai_advisor_alerts SET "notified_at" = now(), "updatedAt" = now()
            WHERE "id" = $1 AND "notified_at" IS NULL`,
          [row.id],
        );
        out.sent += 1;
      } catch (error) {
        out.failed += 1;
        this.logger.warn(
          `ai_advisor_notify_failed alert=${row.id}: ${short(error)}`,
        );
      }
    }
    return out;
  }
}

function short(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
