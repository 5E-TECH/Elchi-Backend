import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TimeoutError } from 'rxjs';
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
  startOfTashkentDay,
} from '@app/common';
import { AdvisorSettingsService } from './advisor-settings.service';
import { formatDay, formatRatio, formatSom, r7Sentence } from './advisor-text';
import { returnedRows } from './advisor-sql';

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
/** R6 Telegram'i shu soatdan (Toshkent) oldin yuborilmaydi. */
export const ADVISOR_R6_TELEGRAM_HOUR = 9;
/** Shundan eski ogohlantirish bildirishnomasiz qoladi (soat). */
export const ADVISOR_NOTIFY_MAX_AGE_HOURS = 24;
/** Dispatch qulfi (qoidalar tick qulflari 716000000224/225 dan alohida). */
export const ADVISOR_NOTIFY_LOCK_KEY = 716_000_000_901;
export const ADVISOR_NOTIFY_BATCH = 20;
/**
 * (round-4 #655 S2) Bitta ogohlantirish bildirishnomasi RAD ETILSA (javob
 * `statusCode` bilan: 400/404/500, yoki payload yaratilmadi) — urinishlar
 * soni: shundan keyin `notify_skipped='failed'` (yakuniy). Oraliq
 * eksponensial: 30 daqiqa, 1 soat, 2 soat, 4 soat (5-urinish — oxirgi).
 * Xizmat YETIB BO'LMASA (timeout / transport) — bu qatorning aybi emas:
 * hisoblagich oshmaydi, keyingi tick qayta uriniladi (§9.2 «jiddiy xabar
 * yo'qolmasin»; 24 soatlik `stale` chegarasi baribir ishlaydi).
 * Hisoblagich jarayon xotirasida — ai-service BITTA instansiya bo'lishi
 * shart (dispatch advisory qulf bilan); restartda nolga tushadi.
 */
export const ADVISOR_NOTIFY_MAX_ATTEMPTS = 5;
/** Bitta tick'da ketma-ket shuncha 5xx — xizmat nosoz, partiya to'xtaydi. */
export const ADVISOR_NOTIFY_MAX_SERVER_ERRORS = 3;
const NOTIFY_BACKOFF_BASE_MS = 30 * 60_000;
export const advisorNotifyBackoffMs = (attempt: number): number =>
  NOTIFY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
/** Tick vaqti siljishi (qoidalar fazasi davomiyligi) — oraliq bir tick'ka siljimasin. */
const NOTIFY_BACKOFF_SLACK_MS = 2 * 60_000;
/**
 * Qatorning aybi emas — xizmat yetib bo'lmadi (timeout / transport,
 * `statusCode` yo'q) yoki xizmatning o'zi nosoz (5xx: `toRpcError` har
 * kutilmagan istisnoni 500 qiladi — deploy xatosi, pool buzilishi).
 * Hisoblanmaydi (§9.2; 24 soatlik `stale` baribir chegaralaydi). Faqat 4xx
 * (qator/payload rad etildi) urinish sifatida sanaladi.
 */
/** Javob yo'q (timeout / transport) — partiya to'xtaydi (tick'ka bitta 8 s kutish). */
export const isDispatchNoReply = (error: unknown): boolean =>
  error instanceof TimeoutError ||
  typeof (error as { statusCode?: unknown } | null)?.statusCode !== 'number';
export const isDispatchUnreachable = (error: unknown): boolean => {
  if (isDispatchNoReply(error)) return true;
  const code = (error as { statusCode: number }).statusCode;
  return code >= 500 || code === 429 || code === 408;
};
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
  /**
   * Kechiktirilgan Telegram (R6 09:00): ilova ichidagi qator QAYTA
   * ko'tarilmaydi (o'qilgan/tartib/count o'zgarmaydi) — faqat Telegram.
   */
  delivery_only?: boolean;
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
    /**
     * `default` — ilova + (ruxsat bo'lsa) Telegram; `no_telegram` — Telegram
     * kechiktirilgan (R6 tunda); `telegram_only` — kechiktirilgan Telegram
     * yo'nalishi (alohida `client_request_id`).
     */
    mode?: 'default' | 'no_telegram' | 'telegram_only';
  },
): AdvisorDispatchPayload | null {
  const recipients = [
    ...new Set(input.recipients.filter((id) => /^\d{1,18}$/.test(id))),
  ];
  if (!recipients.length) return null;
  const facts = row.facts ?? {};
  const mode = input.mode ?? 'default';
  const telegram = advisorTelegramAllowed(row.rule_key, input);
  const channels = mode === 'telegram_only' ? [] : ['in_app', 'realtime'];
  if (telegram && mode !== 'no_telegram') channels.push('telegram');
  if (!channels.length) return null;
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
    client_request_id: deterministicUuid(
      mode === 'telegram_only'
        ? `ai-advisor-alert:${row.id}:tg`
        : `ai-advisor-alert:${row.id}`,
    ),
    ...(mode === 'telegram_only' ? { delivery_only: true } : {}),
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

/** `settings.telegram.enabled` VA `rules.<R>.telegram` (§9.2). */
export function advisorTelegramAllowed(
  rule: AiAdvisorRuleKey,
  input: { rules: AiAdvisorRulesSettings; telegramEnabled: boolean },
): boolean {
  return input.telegramEnabled && input.rules[rule]?.telegram !== false;
}

/** Shu soatdan (Toshkent) keyin ham tun — R6 Telegram ertasi kuni 09:00 da. */
export const ADVISOR_R6_NIGHT_START_HOUR = 22;

/**
 * R6 (ega, 2026-11-15): Telegram tunda yo'q — Toshkent 22:00–09:00 oralig'ida
 * kechiktiriladi: 09:00 gacha — o'sha kuni 09:00; 22:00 dan keyin — ertasi
 * kuni 09:00 (#705 S4). 09:00 dan keyin, 22:00 gacha — darhol (`null`).
 */
export function r6TelegramDueAt(
  rule: AiAdvisorRuleKey,
  now: Date,
): Date | null {
  if (rule !== 'R6') return null;
  const dayStart = startOfTashkentDay(now).getTime();
  const nine = new Date(dayStart + ADVISOR_R6_TELEGRAM_HOUR * 3600_000);
  if (now < nine) return nine;
  if (now.getTime() >= dayStart + ADVISOR_R6_NIGHT_START_HOUR * 3600_000)
    return new Date(nine.getTime() + 86_400_000);
  return null;
}

@Injectable()
export class AdvisorNotifier {
  private readonly logger = new Logger(AdvisorNotifier.name);
  private recipientsCache: { ids: string[]; at: number } | null = null;
  /** (S2) Muvaffaqiyatsiz urinishlar: alert id → {n, keyingi urinish}. */
  private readonly attempts = new Map<string, { n: number; next: number }>();
  /**
   * Oxirgi «yetib bo'lmadi» (timeout / transport / 5xx) vaqti: id+suffix → ms.
   * Navbat shu vaqt bo'yicha AYLANADI: hech yiqilmaganlar — oldin, keyin eng
   * uzoq kutganlar, hozir yiqilgani — oxirida. Engine har tick `updatedAt` ni
   * yangilasa ham (`touch` bekor bo'ladi), `break` (javobsiz / ketma-ket 3×5xx)
   * ortidagilarni abadiy to'smaydi. Muvaffaqiyatda o'chadi, 48 soatda kesiladi.
   */
  private readonly unreachableAt = new Map<string, number>();
  private markUnreachable(key: string, now: Date): void {
    this.unreachableAt.delete(key);
    this.unreachableAt.set(key, now.getTime());
  }
  private unreachableOrder(now: Date, suffix: string): string[] {
    const cutoff = now.getTime() - 2 * ADVISOR_NOTIFY_MAX_AGE_HOURS * 3600_000;
    const out: Array<[string, number]> = [];
    for (const [k, at] of this.unreachableAt) {
      if (at < cutoff) this.unreachableAt.delete(k);
      else if (suffix ? k.endsWith(suffix) : !k.includes(':'))
        out.push([k.slice(0, k.length - suffix.length), at]);
    }
    return out.sort((a, b) => a[1] - b[1]).map(([id]) => id);
  }

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
        // §9.3: faqat FAOL superadminlar (nofaol — inbox/Telegram yo'q).
        active_only: true,
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
  /**
   * Bitta jarayon: ikki cron (30 daq va 02:30) bir vaqtda tushsa ham
   * dispatch ikki marta yuborilmaydi — alohida advisory qulf (round-2 S1).
   * Qulf olinmasa — shu tick o'tkaziladi (boshqasi yuboryapti).
   */
  async dispatchPending(
    now: Date = new Date(),
  ): Promise<{ sent: number; failed: number }> {
    const runner = this.ds.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const [row] = (await runner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS ok',
        [ADVISOR_NOTIFY_LOCK_KEY],
      )) as Array<{ ok: boolean }>;
      locked = row?.ok === true;
      if (!locked) return { sent: 0, failed: 0 };
      const main = await this.dispatchBatch(now);
      const tg = await this.dispatchDeferredTelegram(now);
      return { sent: main.sent + tg.sent, failed: main.failed + tg.failed };
    } finally {
      if (locked) {
        await runner
          .query('SELECT pg_advisory_unlock($1::bigint)', [
            ADVISOR_NOTIFY_LOCK_KEY,
          ])
          .catch(() => undefined);
      }
      await runner.release().catch(() => undefined);
    }
  }

  private async dispatchBatch(
    now: Date,
  ): Promise<{ sent: number; failed: number }> {
    const out = { sent: 0, failed: 0 };
    let serverErrors = 0;
    // 24 soatdan eski (birinchi aniqlangan) ogohlantirish endi yuborilmaydi —
    // uzilish/superadmin yo'qligidan keyin eski xabarlar to'lqini bo'lmasin
    // (round-2 S3, kelishilgan). `notify_skipped='stale'` REST'da ko'rinmaydi.
    const stale = returnedRows<{ id: string }>(
      await this.ds.query<unknown>(
        `UPDATE ai_schema.ai_advisor_alerts SET "notify_skipped" = 'stale', "updatedAt" = now()
          WHERE "severity" = 'critical' AND "status" IN ('new','seen') AND "is_deleted" = false
            AND "notified_at" IS NULL AND "notify_skipped" IS NULL
            AND "first_at" < now() - INTERVAL '${ADVISOR_NOTIFY_MAX_AGE_HOURS} hours'
          RETURNING "id"::text AS id`,
      ),
    );
    if (stale.length)
      this.logger.warn(`ai_advisor_notify_stale skipped=${stale.length}`);
    // Tartib — oxirgi urinish bo'yicha (xatoda `updatedAt` yangilanadi):
    // doimiy xatoli qatorlar yangilarini to'sib qo'ymaydi (round-2 S2).
    // Eskirgan hisoblagichlar (yozuv boshqa yo'l bilan yopilgan) — tozalanadi.
    for (const [id, a] of this.attempts)
      if (a.next < now.getTime() - ADVISOR_NOTIFY_MAX_AGE_HOURS * 3600_000)
        this.attempts.delete(id);
    // Oraliq tugamagan (backoff) qatorlar so'ralmaydi — partiya joyini olmaydi.
    const waiting = this.waitingIds(now, '');
    const rows = await this.ds.query<
      Array<AdvisorNotifyRow & { first_at: Date | null }>
    >(
      `SELECT a."id"::text AS id, a."rule_key", a."severity", a."title", a."facts", a."subject", a."branch",
              a."first_at"
         FROM ai_schema.ai_advisor_alerts a
        WHERE a."severity" = 'critical' AND a."status" IN ('new','seen') AND a."is_deleted" = false
          AND a."notified_at" IS NULL AND a."notify_skipped" IS NULL
          AND NOT (a."id" = ANY($1::bigint[]))
        ORDER BY COALESCE(array_position($2::bigint[], a."id"), 0) ASC, a."updatedAt" ASC, a."id" ASC
        LIMIT ${ADVISOR_NOTIFY_BATCH}`,
      [waiting, this.unreachableOrder(now, '')],
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
    // Bo'sh ro'yxat — identity xatosi kabi (#705 S3): urinish yozilmaydi.
    if (!recipients.length) {
      this.logger.warn(`ai_advisor_notify: superadminlar ro'yxati bo'sh`);
      return { sent: 0, failed: rows.length };
    }
    const rules = await this.settings.getRules();
    const telegramEnabled = await this.settings.telegramEnabled();
    const cabinetUrl = this.config?.get<string>('ELCHI_CABINET_URL') ?? null;
    for (const row of rows) {
      const telegram = advisorTelegramAllowed(row.rule_key, {
        rules,
        telegramEnabled,
      });
      // R6 rejimi ogohlantirish OCHILGAN paytdan (#705 S6): tunda ochilgan R6
      // ning birinchi urinishi yiqilib, qayta urinish 09:00 dan keyin bo'lsa
      // ham ayni client_request_id ilova ichi uchun, Telegram — alohida
      // kechiktirilgan yo'l bilan (due = hozir, shu tick'da ketadi).
      // Kunduz ochilgan R6 tunda qayta urinilsa — hozirgi vaqt bo'yicha due
      // (tun bo'lsa ertasi 09:00): Telegram tunda ketmaydi.
      const firstAt = row.first_at ? new Date(row.first_at) : null;
      const openedAt =
        firstAt && firstAt.getTime() <= now.getTime() ? firstAt : now;
      const r6Due = telegram ? r6TelegramDueAt(row.rule_key, openedAt) : null;
      const nowDue = telegram ? r6TelegramDueAt(row.rule_key, now) : null;
      // 09:00 o'tgan: hozir kunduz bo'lsa — darhol; tun bo'lsa (uzilish yarim
      // tundan o'tgan) — bugungi 09:00 (R6 ega qarori: Telegram tunda yo'q).
      const telegramDueAt =
        r6Due && r6Due.getTime() < now.getTime()
          ? (nowDue ?? now)
          : (r6Due ?? nowDue);
      const payload = buildAdvisorDispatch(row, {
        recipients,
        rules,
        telegramEnabled,
        cabinetUrl,
        mode: telegramDueAt ? 'no_telegram' : 'default',
      });
      if (!payload) {
        out.failed += 1;
        await this.attemptFailed(row.id, now, 'payload yaratilmadi');
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
          `UPDATE ai_schema.ai_advisor_alerts
              SET "notified_at" = now(), "telegram_due_at" = $2, "updatedAt" = now()
            WHERE "id" = $1 AND "notified_at" IS NULL`,
          [row.id, telegramDueAt],
        );
        this.attempts.delete(row.id);
        this.unreachableAt.delete(row.id);
        serverErrors = 0;
        out.sent += 1;
      } catch (error) {
        out.failed += 1;
        if (isDispatchUnreachable(error)) {
          // Xizmat yo'q: hisoblagich oshmaydi, navbat oxiriga, partiya to'xtaydi
          // (uzilish tick'iga bitta RPC kutish — qator jazolanmaydi).
          await this.touch(row.id);
          this.logger.warn(
            `ai_advisor_notify_unreachable alert=${row.id}: ${short(error)}`,
          );
          this.markUnreachable(row.id, now);
          if (isDispatchNoReply(error)) break;
          // 5xx tez javob — qatorga xos xato boshqalarni to'smasin (davom);
          // ketma-ket 3 ta — xizmat butunlay nosoz, tick to'xtaydi.
          if (++serverErrors >= ADVISOR_NOTIFY_MAX_SERVER_ERRORS) break;
          continue;
        }
        await this.attemptFailed(row.id, now, short(error));
      }
    }
    return out;
  }

  /** Oraliq (backoff) tugamagan qatorlar — `suffix` ('' | ':tg') bo'yicha. */
  private waitingIds(now: Date, suffix: string): string[] {
    return [...this.attempts]
      .filter(
        ([key, a]) =>
          (suffix ? key.endsWith(suffix) : !key.includes(':')) &&
          a.next - NOTIFY_BACKOFF_SLACK_MS > now.getTime(),
      )
      .map(([key]) => key.slice(0, key.length - suffix.length));
  }

  /** Navbat oxiriga (keyingi tick boshqalari oldin). */
  private async touch(id: string): Promise<void> {
    await this.ds
      .query(
        `UPDATE ai_schema.ai_advisor_alerts SET "updatedAt" = now() WHERE "id" = $1`,
        [id],
      )
      .catch(() => undefined);
  }

  /**
   * (S2) Rad etilgan urinish: oraliq (backoff) belgilanadi, navbat oxiriga;
   * `ADVISOR_NOTIFY_MAX_ATTEMPTS` dan keyin — `giveUp` (asosiy: `notify_skipped
   * = 'failed'`; 09:00 Telegram: `telegram_due_at` tozalanadi). `giveUp`
   * yozuvi yiqilsa — hisoblagich saqlanadi, keyingi tick qayta voz kechadi.
   */
  private async attemptFailed(
    id: string,
    now: Date,
    reason: string,
    suffix = '',
    giveUp: () => Promise<unknown> = () =>
      this.ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET "notify_skipped" = 'failed', "updatedAt" = now()
          WHERE "id" = $1 AND "notified_at" IS NULL AND "notify_skipped" IS NULL`,
        [id],
      ),
  ): Promise<void> {
    const key = id + suffix;
    const n = (this.attempts.get(key)?.n ?? 0) + 1;
    if (n >= ADVISOR_NOTIFY_MAX_ATTEMPTS) {
      try {
        await giveUp();
      } catch (error) {
        this.attempts.set(key, { n: n - 1, next: now.getTime() });
        this.logger.error(
          `ai_advisor_notify_give_up_failed alert=${key}: ${short(error)}`,
        );
        return;
      }
      this.attempts.delete(key);
      this.logger.error(
        `ai_advisor_notify_gave_up alert=${key} attempts=${n}: ${reason}`,
      );
      return;
    }
    this.attempts.set(key, {
      n,
      next: now.getTime() + advisorNotifyBackoffMs(n),
    });
    await this.touch(id);
    this.logger.warn(
      `ai_advisor_notify_failed alert=${key} attempt=${n}: ${reason}`,
    );
  }

  /**
   * Kechiktirilgan Telegram (R6, 09:00): bir marta, alohida
   * `client_request_id` (`…:tg`). Ogohlantirish yopilgan / Telegram
   * o'chirilgan / 24 soatdan eski — yuborilmaydi, belgi tozalanadi.
   */
  private async dispatchDeferredTelegram(
    now: Date,
  ): Promise<{ sent: number; failed: number }> {
    const out = { sent: 0, failed: 0 };
    let serverErrors = 0;
    // R6 Telegram'i tunda yo'q (Toshkent 22:00–09:00) — kechiktirilgan yo'lning
    // QAYTA urinishlari ham (#705 bloker): 09:00 dagi yuborish uzilib, 22:00
    // dan keyin tiklansa — ertasi 09:00 (`fresh` chegarasigacha), tunda emas.
    if (r6TelegramDueAt('R6', now)) return out;
    const rows = await this.ds.query<
      Array<
        AdvisorNotifyRow & { status: string; is_deleted: boolean; due: Date }
      >
    >(
      `SELECT a."id"::text AS id, a."rule_key", a."severity", a."title", a."facts", a."subject",
              a."branch", a."status", a."is_deleted", a."telegram_due_at" AS due
         FROM ai_schema.ai_advisor_alerts a
        WHERE a."telegram_due_at" IS NOT NULL AND a."telegram_due_at" <= $1
          AND NOT (a."id" = ANY($2::bigint[]))
        ORDER BY COALESCE(array_position($3::bigint[], a."id"), 0) ASC, a."updatedAt" ASC, a."id" ASC
        LIMIT ${ADVISOR_NOTIFY_BATCH}`,
      [now, this.waitingIds(now, ':tg'), this.unreachableOrder(now, ':tg')],
    );
    if (!rows.length) return out;
    const clear = (id: string) =>
      this.ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET "telegram_due_at" = NULL, "updatedAt" = now()
          WHERE "id" = $1 AND "telegram_due_at" IS NOT NULL`,
        [id],
      );
    const rules = await this.settings.getRules();
    const telegramEnabled = await this.settings.telegramEnabled();
    const cabinetUrl = this.config?.get<string>('ELCHI_CABINET_URL') ?? null;
    let recipients: string[] | null = null;
    for (const row of rows) {
      const open =
        !row.is_deleted && (row.status === 'new' || row.status === 'seen');
      const fresh =
        now.getTime() - new Date(row.due).getTime() <
        // 24 soat + bitta tun (22:00–09:00): kunduzgi oyna to'liq o'tib ketgan
        // Telegram ertasi 09:00 da bir marta ketadi, keyin — yo'q.
        (ADVISOR_NOTIFY_MAX_AGE_HOURS +
          24 -
          ADVISOR_R6_NIGHT_START_HOUR +
          ADVISOR_R6_TELEGRAM_HOUR) *
          3600_000;
      if (
        !open ||
        !fresh ||
        !advisorTelegramAllowed(row.rule_key, { rules, telegramEnabled })
      ) {
        await clear(row.id);
        continue;
      }
      // Qabul qiluvchilar — qator xatosi EMAS (#705 S-c): olinmasa partiya
      // to'xtaydi, hech bir qatorga urinish yozilmaydi (dispatchBatch kabi).
      if (recipients === null) {
        try {
          recipients = await this.recipients();
        } catch (error) {
          this.logger.warn(
            `ai_advisor_notify_telegram: superadminlar olinmadi — ${short(error)}`,
          );
          return { sent: out.sent, failed: out.failed + 1 };
        }
        if (!recipients.length) {
          this.logger.warn(
            `ai_advisor_notify_telegram: superadminlar ro'yxati bo'sh`,
          );
          return { sent: out.sent, failed: out.failed + 1 };
        }
      }
      try {
        const payload = buildAdvisorDispatch(row, {
          recipients,
          rules,
          telegramEnabled,
          cabinetUrl,
          mode: 'telegram_only',
        });
        if (!payload) {
          // Qabul qiluvchi / matn yo'q — qayta urinish yordam bermaydi.
          out.failed += 1;
          await clear(row.id);
          this.logger.warn(
            `ai_advisor_notify_telegram_skipped alert=${row.id}: payload yo'q`,
          );
          continue;
        }
        await rmqSend(
          this.notification,
          { cmd: 'notification.dispatch' },
          payload,
          { timeoutMs: 8_000, retries: 0 },
        );
        await clear(row.id);
        this.attempts.delete(`${row.id}:tg`);
        this.unreachableAt.delete(`${row.id}:tg`);
        serverErrors = 0;
        out.sent += 1;
      } catch (error) {
        out.failed += 1;
        if (isDispatchUnreachable(error)) {
          // Navbat oxiriga (S-b): o'z timeout'i bor qator boshqalarini to'smaydi.
          await this.touch(row.id);
          this.logger.warn(
            `ai_advisor_notify_telegram_unreachable alert=${row.id}: ${short(error)}`,
          );
          this.markUnreachable(`${row.id}:tg`, now);
          if (isDispatchNoReply(error)) break;
          if (++serverErrors >= ADVISOR_NOTIFY_MAX_SERVER_ERRORS) break;
          continue;
        }
        await this.attemptFailed(row.id, now, short(error), ':tg', () =>
          clear(row.id),
        );
      }
    }
    return out;
  }
}

function short(error: unknown): string {
  // Log uchun: hech qachon tashlamaydi (aylanma / prototipsiz obyekt, getter).
  try {
    if (error instanceof Error) return error.message.slice(0, 200);
    // RPC xatosi — `{statusCode, message}` obyekti ('[object Object]' emas).
    if (error && typeof error === 'object') {
      const e = error as { statusCode?: unknown; message?: unknown };
      const code =
        typeof e.statusCode === 'number' || typeof e.statusCode === 'string'
          ? String(e.statusCode)
          : '';
      const msg =
        typeof e.message === 'string'
          ? e.message
          : Array.isArray(e.message) // class-validator 400
            ? e.message
                .filter((m): m is string => typeof m === 'string')
                .join('; ')
            : '';
      if (code || msg) return `${code} ${msg}`.trim().slice(0, 200);
      return JSON.stringify(error).slice(0, 200);
    }
    return String(error).slice(0, 200);
  } catch {
    return 'unprintable error';
  }
}
