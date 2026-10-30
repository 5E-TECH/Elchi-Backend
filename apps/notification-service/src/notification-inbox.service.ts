import {
  BadRequestException,
  Inject,
  Injectable,
  forwardRef,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { lastValueFrom, timeout } from 'rxjs';
import { randomUUID } from 'node:crypto';
import {
  ActivityLogService,
  FREE_NOTIFICATION_TYPE_PREFIX,
  NOTIFICATION_TYPES,
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationPriority,
  escapeTelegramHtml,
  findNotificationType,
  isKnownNotificationType,
  maskPhonesForLog,
  missingGroupKeyVariables,
  notificationTypeErrorMessage,
  resolveNotificationDefaults,
  rmqSend,
} from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import { Notification } from './entities/notification.entity';
import { DispatchNotificationDto } from './dto/dispatch-notification.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { NotificationServiceService } from './notification-service.service';
import { PushDeliveryService } from './push/push-delivery.service';
import {
  SmsChannelResult,
  SmsDispatchService,
} from './sms/sms-dispatch.service';
import { SmsBlockedError } from './sms/sms-gate.service';
import {
  AUDIENCE_RESOLVE_PATTERN,
  IdentityAudienceTarget,
  audienceRpcError,
  buildAudienceTarget,
  toAudiencePage,
} from './audience/audience-request';
import {
  DispatchAbortedError,
  InternalDispatchOptions,
} from './campaign/dispatch-hooks';
import { ChannelPlannerService } from './channels/channel-planner.service';
import {
  initialChannelStatus,
  requestedChannels,
} from './channels/resolve-channels';
import { NotificationEscalationService } from './escalation/notification-escalation.service';
import {
  DispatchHistoryService,
  historyStatusFor,
} from './history/dispatch-history.service';
import type { NotificationDispatch } from './history/notification-dispatch.entity';
import { TelegramDmService } from './telegram/telegram-dm.service';
import { InboxPolicyService } from './retention/inbox-policy.service';
import { RecipientDirectoryService } from './recipients/recipient-directory.service';
import { DispatchDedupService } from './dedup/dispatch-dedup.service';
import {
  DispatchTexts,
  NotificationTemplateService,
} from './templates/notification-template.service';

/** Upper bound on role/broadcast fan-out, so one dispatch can't insert millions
 * of rows. (QFoRULeu) Oshsa dispatch 400 bilan rad etiladi — jimgina kesilmaydi. */
export const MAX_FANOUT = 5000;
const IDENTITY_PAGE_SIZE = 100;
/** Bitta INSERT dagi qatorlar — Postgres 65 535 parametr chegarasidan uzoq. */
const INSERT_CHUNK = 500;
/** Qayta o'qishdagi `IN (...)` hajmi. */
const READ_CHUNK = 1000;
/** Aniq qabul qiluvchilarga realtime emit — bir vaqtda shuncha (ketma-ket emas). */
const REALTIME_CONCURRENCY = 50;
/** `delivery.*_error` maksimal uzunligi — provayder javobi to'liq yozilmaydi (PII). */
const DELIVERY_REASON_MAX = 200;

interface ResolvedRecipient {
  id: string;
  role: string | null;
  /** `explicit` — recipient_id(s); `identity` — roles/broadcast orqali topilgan. */
  via: 'explicit' | 'identity';
}

/** Bitta qatorning `delivery` JSONB'iga qo'shiladigan kanal natijasi. */
type DeliveryPatch = Record<string, string | number>;

interface RealtimeResult {
  /** notification id → `{ realtime, realtime_error? }`. */
  outcomes: Map<string, DeliveryPatch>;
  emitted: number;
}

interface TelegramOutcome extends DeliveryPatch {
  telegram: NotificationDeliveryStatus;
}

/** (BOT-3c) Tranzaksiyada navbatga qo'yilgan guruh relay'i (outbox id'lari). */
interface GroupRelay {
  /** `null` — guruh topilmadi (yoki xato). */
  ids: string[] | null;
  error?: unknown;
}

/** Qabul qiluvchi bo'yicha boshlang'ich `delivery` (kanal rejasi, 7Ec56EIw). */
type DeliveryFor = (recipientId: string) => Record<string, string>;

/** (C4R3YyvH) Qabul qiluvchi tilidagi shablon matni; null — DTO'dagi xom matn. */
type TextFor = (
  recipientId: string,
) => { title: string; body: string | null } | null;

interface ChannelPlanView {
  deliveryFor: DeliveryFor;
  /** Sozlama bilan ro'yxatdan tushganlar (mP1WGG1W `skipped_by_preference`). */
  skipped: ReadonlySet<string>;
}

/**
 * Xato sababini `delivery` ga yozishga yaroqli qiladi: telefonlar maskalanadi,
 * 200 belgiga kesiladi — provayder/xom javob to'liq saqlanmaydi (uFmUS86e).
 */
function shortReason(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown';
  return maskPhonesForLog(text.replace(/\s+/g, ' ').trim()).slice(
    0,
    DELIVERY_REASON_MAX,
  );
}

/** "Faqat muhim" filtri va sanog'i (n1sNvGLn). */
const IMPORTANT_PRIORITIES = [
  NotificationPriority.CRITICAL,
  NotificationPriority.HIGH,
] as const;

/** (7Vozou5x) Frontend `client_request_id` — UUID (kichik harf). */
const CLIENT_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Postgres BIGINT yuqori chegarasi. */
const BIGINT_MAX = BigInt('9223372036854775807');

/** (BoMa1A1R) Qabul qiluvchi id — `^\d+$` va BIGINT'ga sig'adi (raqam ham qabul). */
function isBigintId(value: unknown): boolean {
  const text =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : '';
  if (!/^\d{1,19}$/.test(text)) return false;
  const id = BigInt(text);
  return id > BigInt(0) && id <= BIGINT_MAX;
}

/** (3SeRYFqx) Solishtirish uchun kanonik id (' 042' -> '42'). */
function canonicalId(value: unknown): string {
  const text =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  try {
    return /^[0-9]+$/.test(text) ? BigInt(text).toString() : text;
  } catch {
    return text;
  }
}

/**
 * (A1HzKEby) Qatorga yig'ilgan hodisalar soni — `data.count`; yo'q (eski
 * yoki birinchi hodisa) — 1.
 */
function eventCount(data: unknown): number {
  const raw = (data as { count?: unknown } | null | undefined)?.count;
  const count =
    typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  return Number.isInteger(count) && count >= 1 ? count : 1;
}

@Injectable()
export class NotificationInboxService {
  private readonly logger = new Logger(NotificationInboxService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('GATEWAY') private readonly gatewayClient: ClientProxy,
    // ⚠️ Aylanma import (notification-service.service → inbox → telegram-dm →
    // notification-service.service): forwardRef bo'lmasa Nest bu parametrni
    // aniqlay olmaydi va servis BOOT'da yiqiladi.
    @Inject(forwardRef(() => NotificationServiceService))
    private readonly telegramService: NotificationServiceService,
    private readonly activityLog: ActivityLogService,
    private readonly pushDelivery: PushDeliveryService,
    private readonly smsDispatch: SmsDispatchService,
    /**
     * (7Ec56EIw / mP1WGG1W) Kanal rejasi: sozlamalar + kanal imkoniyati.
     * Modulda DOIM bor; yo'q bo'lsa (eski unit spec'lar) — avvalgi xulq:
     * hamma so'ralgan kanal hamma qabul qiluvchiga.
     */
    @Optional() private readonly planner?: ChannelPlannerService,
    /** (7Ec56EIw #5) CRITICAL → N daqiqadan keyin SMS eskalatsiyasi. */
    @Optional() private readonly escalation?: NotificationEscalationService,
    /** (7Vozou5x) Yuborilgan xabarlar tarixi — faqat qo'lda (aktorli) dispatch. */
    @Optional() private readonly history?: DispatchHistoryService,
    /** (rCFZAmOz #2) Guruh nishoni yo'q TELEGRAM — shaxsiy DM (telegram_id). */
    @Optional() private readonly telegramDm?: TelegramDmService,
    /** (C4R3YyvH) Shablonlar reyestri — DB'dagi shablon xom matnni almashtiradi. */
    @Optional() private readonly templates?: NotificationTemplateService,
    /**
     * (A1HzKEby #4) Bo'ron chegarasi (NOTIF_HOURLY_CAP_PER_TYPE). Modulda
     * DOIM bor; yo'q bo'lsa (eski unit spec'lar) — chegara o'chiq.
     */
    @Optional() private readonly policy?: InboxPolicyService,
    /**
     * (3SeRYFqx #3) Aniq recipient_id(s) identity'da bormi — yetim qator
     * yozilmasin. Modulda DOIM bor; yo'q bo'lsa (eski unit spec'lar) —
     * tekshiruvsiz (avvalgi xulq).
     */
    @Optional() private readonly directory?: RecipientDirectoryService,
    /** (rzGKtE9N TC5) qayta yetkazilgan dispatch — ikkinchi xabar yo'q. */
    @Optional() private readonly dedup?: DispatchDedupService,
  ) {}

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) throw error;
    // (xHPdpj0W) Kampaniya partiyasi ataylab to'xtatdi — o'ralmaydi.
    if (error instanceof DispatchAbortedError) throw error;
    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }
    if (error instanceof BadRequestException) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }
    // (BoMa1A1R) DB drayveri / kutilmagan xato matni mijozga UZATILMAYDI:
    // avval `error.message` to'g'ridan-to'g'ri qaytardi va Postgres tip
    // nomlari hamda ustun qiymatlari (`invalid input syntax for type bigint:
    // "abc"`) javobda ochilardi. To'liq sabab faqat logda (telefon maskada).
    this.logger.error(
      `notification RPC xatosi: ${shortReason(error)}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw new RpcException({
      statusCode: 500,
      message: 'Internal server error',
    });
  }

  /**
   * (BoMa1A1R) `recipient_id(s)` — faqat bigint'ga sig'adigan musbat raqam.
   * Dispatch UMUMAN boshlanmaydi (400): qisman yozish ham, xom DB xatosi ham
   * bo'lmaydi. RMQ'da ValidationPipe yo'q, shuning uchun tekshiruv shu yerda.
   */
  private assertRecipientIds(dto: DispatchNotificationDto) {
    const invalid: string[] = [];
    if (dto.recipient_id !== undefined && dto.recipient_id !== null) {
      if (!isBigintId(dto.recipient_id)) invalid.push(String(dto.recipient_id));
    }
    if (dto.recipient_ids !== undefined && dto.recipient_ids !== null) {
      if (!Array.isArray(dto.recipient_ids)) {
        throw new BadRequestException('recipient_ids must be an array');
      }
      for (const id of dto.recipient_ids) {
        if (!isBigintId(id)) invalid.push(String(id));
      }
    }
    if (invalid.length) {
      const sample = invalid
        .slice(0, 5)
        .map((id) => JSON.stringify(id.slice(0, 32)))
        .join(', ');
      throw new BadRequestException(
        `recipient_ids: har element musbat butun son (bigint) bo'lishi kerak — noto'g'ri: ${sample}${
          invalid.length > 5 ? ` (+${invalid.length - 5})` : ''
        }`,
      );
    }
  }

  // ==================== DISPATCH (the generic entry point) ====================

  /**
   * Dispatch partiyasi ID si (f2Ud5tju #6): (7Vozou5x) frontend
   * `client_request_id` (UUID) → chaqiruvchi `request_id` → yangi UUID.
   */
  private dispatchBatchId(dto: DispatchNotificationDto): string {
    return this.requestDispatchId(dto) ?? randomUUID();
  }

  /**
   * Chaqiruvchi bergan barqaror ID (`client_request_id` yoki `request_id`):
   * qayta yetkazishda o'zgarmaydi. Yo'q — `null` (tasodifiy partiya ID si).
   */
  private requestDispatchId(dto: DispatchNotificationDto): string | null {
    const client =
      typeof dto.client_request_id === 'string'
        ? dto.client_request_id.trim().toLowerCase()
        : '';
    if (CLIENT_REQUEST_ID_RE.test(client)) return client;
    const raw = (dto as { request_id?: unknown }).request_id;
    const requestId = typeof raw === 'string' ? raw.trim() : '';
    // activity_logs.entity_id — VARCHAR(100).
    return requestId && requestId.length <= 100 ? requestId : null;
  }

  /** (rzGKtE9N TC5) Qayta yetkazilgan dispatch — hech narsa yozilmadi/yuborilmadi. */
  private redeliveryResponse(dispatchId: string, channels: string[]) {
    return successRes(
      {
        dispatch_id: dispatchId,
        dispatched: 0,
        duplicate: true,
        recipient_ids: [],
        channels,
      },
      200,
      'Already dispatched (duplicate request_id) — not sent again',
    );
  }

  /**
   * (7Vozou5x) Ayni `dispatch_id` bilan takror (504 dan keyin qayta bosish) —
   * QAYTA yuborilmaydi, tarixdagi natija qaytadi (`duplicate: true`).
   */
  private duplicateResponse(row: NotificationDispatch) {
    return successRes(
      {
        dispatch_id: row.dispatch_id,
        duplicate: true,
        status: row.status,
        dispatched: row.dispatched,
        channels: row.channels ?? [],
        by_channel: row.by_channel ?? {},
        channel_status: row.channel_status ?? null,
        no_provider: row.no_provider ?? [],
        skipped_by_preference: row.skipped_by_preference,
      },
      200,
      row.status === 'running'
        ? 'Dispatch already in progress — check /notifications/sent'
        : 'Already dispatched (duplicate client_request_id) — not sent again',
    );
  }

  /**
   * `internal` — FAQAT kod ichidan (xHPdpj0W kampaniya partiyasi): tayyor
   * qabul qiluvchilar va tranzaksiya ilgaklari. RMQ controller uni bermaydi.
   */
  async dispatch(
    dto: DispatchNotificationDto,
    internal?: InternalDispatchOptions,
  ) {
    // (7Vozou5x) Tarix qatori ochilgan bo'lsa — xato ham tarixga (`failed`).
    let historyId: string | null = null;
    try {
      if (!dto.type?.trim()) throw new BadRequestException('type is required');
      if (!dto.title?.trim())
        throw new BadRequestException('title is required');
      // (Eh8y21Ha) Reyestr — FAIL-CLOSED. RMQ'da ValidationPipe yo'q, shuning
      // uchun ichki chaqiruvchilar (order-service outbox, ai-service) uchun
      // tekshiruv shu yerda; gateway DTO ham xuddi shuni tekshiradi.
      if (!isKnownNotificationType(dto.type)) {
        throw new BadRequestException(notificationTypeErrorMessage(dto.type));
      }
      // Berilmagan category/priority/group_key/channels — KATALOGDAN (DTO
      // ustun). `dto` ning o'zi to'ldiriladi: audit metadata ham aynan
      // yozilgan kategoriyani ko'radi (qattiq SYSTEM sukuti emas).
      const defaults = resolveNotificationDefaults({
        type: dto.type,
        category: dto.category,
        priority: dto.priority,
        group_key: dto.group_key,
        channels: dto.channels,
        data: dto.data,
      });
      dto.category = defaults.category;
      dto.priority = defaults.priority;
      dto.group_key = defaults.group_key ?? undefined;
      // (A1HzKEby #1) group_key MAJBURIY: DTO -> katalog shabloni. Shablonli
      // tur uchun data da o'zgaruvchi yetishmasa — 400: aks holda bir
      // obyektning har hodisasi inboxda YANGI qator bo'lib to'planardi.
      // Shablonsiz tur — pastda dispatch partiyasi ID sidan to'ldiriladi.
      const catalogPattern =
        findNotificationType(dto.type)?.group_key_pattern ?? null;
      if (!dto.group_key && catalogPattern) {
        const missing = missingGroupKeyVariables(catalogPattern, dto.data);
        const reason = missing.length
          ? 'data.' + missing.join(', data.') + ' berilmagan'
          : 'shablon natijasi yaroqsiz (255 belgidan uzun)';
        throw new BadRequestException(
          'group_key aniqlanmadi: "' +
            dto.type.trim() +
            '" turi katalogda "' +
            catalogPattern +
            '" shabloni bilan guruhlanadi — ' +
            reason +
            ". group_key ni bering yoki data ni to'ldiring.",
        );
      }

      // (7Ec56EIw #2 a/b) Katalog sukuti yoki chaqiruvchi so'ragani ∩
      // katalogda ruxsat etilgan kanallar — ortiqcha kanal qo'shilmaydi.
      const channels = requestedChannels(dto.type, defaults.channels);

      this.assertRecipientIds(dto);

      const actor = (dto as { requester?: { id?: string; roles?: string[] } })
        .requester;
      /**
       * entity_id — HAQIQIY dispatch partiyasi ID si (f2Ud5tju #6), qattiq
       * `'dispatch'` satri emas (jurnalda hammasi "Notification #dispatch"
       * bo'lib, bir-biridan ajratib bo'lmasdi). Manba: (7Vozou5x) frontend
       * `client_request_id`, so'ng chaqiruvchining `request_id` si (`rmqSend`
       * har chaqiruvga beradi, timeout qayta urinishida o'zgarmaydi — bir
       * partiya bitta ID), bo'lmasa yangi UUID. Shu ID javobda `dispatch_id`
       * bo'lib qaytadi, har inbox qatorida `dispatch_id` ustunida turadi.
       */
      const dispatchId = this.dispatchBatchId(dto);
      // (A1HzKEby #1) Shablonsiz tur (category.manual, system.announcement,
      // account.*, x.*): katalog "har dispatch — yangi qator" deydi.
      // group_key baribir NULL qolmaydi — shu dispatch partiyasining o'zi:
      // turli dispatch'lar birlashmaydi, ayni partiyaning qayta yetkazilishi
      // (bir xil request_id) esa yangi qator qo'shmaydi.
      if (!dto.group_key) {
        dto.group_key = (dto.type.trim() + ':' + dispatchId).slice(0, 255);
      }

      // (7Vozou5x) Qo'lda (aktorli, kampaniya partiyasi emas) dispatch —
      // tarix qatori `running` bilan OLDINDAN ochiladi: 504 bo'lsa ham
      // `GET /notifications/sent/:dispatch_id` holatni ko'rsatadi.
      if (this.history && !internal && actor?.id) {
        const { duplicate } = await this.history.begin({
          dispatch_id: dispatchId,
          created_by: String(actor.id),
          created_by_role: actor.roles?.length
            ? actor.roles.join(',').slice(0, 100)
            : null,
          type: dto.type.trim(),
          category: dto.category ?? null,
          priority: dto.priority ?? null,
          title: dto.title.trim(),
          body: dto.body ?? null,
          link: dto.link ?? null,
          channels,
          audience: this.audienceSummary(dto),
        });
        if (duplicate) return this.duplicateResponse(duplicate);
        historyId = dispatchId;
      }

      let recipients: ResolvedRecipient[] = internal?.recipients
        ? internal.recipients.map((recipient) => ({
            id: String(recipient.id),
            role: recipient.role ?? null,
            via: 'explicit' as const,
          }))
        : await this.resolveRecipients(dto);

      // (3SeRYFqx #3) Aniq recipient_id(s) — identity'da (o'chirilmagan) bormi.
      // Topilmaganga qator YOZILMAYDI (uni hech kim o'qiy/o'chira olmaydi):
      // javobda unresolved, hammasi topilmasa — 400. Kampaniya partiyasi
      // (internal.recipients) identity'dan kelgan — qayta tekshirilmaydi.
      let unresolved: string[] | null = null;
      if (!internal?.recipients && this.directory) {
        const explicit = recipients.filter((r) => r.via === 'explicit');
        unresolved = [];
        if (explicit.length) {
          const found = await this.directory.existing(
            explicit.map((r) => canonicalId(r.id)),
          );
          const missing = new Set(
            explicit
              .map((r) => r.id)
              .filter((id) => !found.has(canonicalId(id))),
          );
          unresolved = [...missing].map((id) => String(id));
          if (missing.size) {
            recipients = recipients.filter((r) => !missing.has(r.id));
          }
        }
        if (!recipients.length && unresolved.length) {
          const more =
            unresolved.length > 20
              ? ' (+' + (unresolved.length - 20) + ')'
              : '';
          throw new BadRequestException(
            "Qabul qiluvchi topilmadi (mavjud emas yoki o'chirilgan): " +
              unresolved.slice(0, 20).join(', ') +
              more +
              ' — hech narsa yozilmadi.',
          );
        }
      }
      if (!recipients.length) {
        // (W8aerwL6) Nishon berilgan-u, hech kim topilmagan bo'lsa — buni aytamiz.
        throw new BadRequestException(
          buildAudienceTarget(dto) || dto.recipient_id || dto.recipient_ids
            ? "No recipients resolved: tanlangan auditoriyada faol foydalanuvchi yo'q (rol / segment bo'sh)."
            : 'No recipients resolved. Provide recipient_id, recipient_ids, roles, broadcast=true or include_customers=true (+segment).',
        );
      }

      // SMS: fan-out chegarasi OLDINDAN — oshsa XATO, jimgina kesilmaydi
      // (MAX_FANOUT=5000 SMS'ga qo'llanmaydi: SMS_MAX_FANOUT).
      const wantsSms = channels.includes(NotificationChannel.SMS);
      if (wantsSms) {
        try {
          this.smsDispatch.assertFanout(recipients.length);
        } catch (error) {
          if (error instanceof SmsBlockedError) {
            throw new BadRequestException(error.message);
          }
          throw error;
        }
      }
      let smsResult: SmsChannelResult | null = null;

      // (rzGKtE9N TC5) Outbox/RMQ qayta yetkazishi: kalit tranzaksiya ICHIDA
      // egallanadi — band bo'lsa qator ham, Telegram/push/SMS ham yo'q.
      // Qo'lda (aktorli) dispatch'ni tarix (`history.begin`) himoyalaydi,
      // kampaniya partiyasini (`internal`) — o'z kursori. Oldindan arzon
      // tekshiruv — takror uchun reja/metrika ham hisoblanmasin.
      const requestId = this.requestDispatchId(dto);
      const dedupKey =
        this.dedup && !internal && !historyId && requestId
          ? DispatchDedupService.key(dto.type, requestId)
          : null;
      if (dedupKey && (await this.dedup?.seen(dedupKey))) {
        return this.redeliveryResponse(dispatchId, channels);
      }

      // (mP1WGG1W / 7Ec56EIw) Sozlamalar va kanal imkoniyati — BULK (sikl
      // ichida so'rov yo'q). Hamma filtrlansa — 400 emas, skipped_by_preference.
      const plan = await this.planChannels(dto, recipients);
      const targets = recipients.filter((r) => !plan.skipped.has(r.id));
      // (7Ec56EIw #5) CRITICAL: N daqiqadan keyin o'qilmagan bo'lsa SMS.
      const escalationDueAt =
        this.escalation?.dueAt(dto.priority, channels) ?? null;
      const planned: DeliveryFor = escalationDueAt
        ? (id) => ({
            ...plan.deliveryFor(id),
            escalation: 'scheduled',
            escalation_due_at: escalationDueAt.toISOString(),
          })
        : plan.deliveryFor;

      // (rCFZAmOz #2) TELEGRAM so'ralgan, guruh nishoni (market_id/group_id)
      // YO'Q — qabul qiluvchining shaxsiy chatiga (users.telegram_id). Chat
      // ulanmagan — `telegram: skipped` + `telegram_reason: no_telegram_id`,
      // dispatch YIQILMAYDI. Yuborish outbox orqali (tranzaksiya ichida navbat).
      const dmPlan =
        this.telegramDm &&
        TelegramDmService.wantsDm(channels, dto.telegram ?? null)
          ? await this.telegramDm.plan(
              targets
                .filter(
                  (r) =>
                    planned(r.id)[NotificationChannel.TELEGRAM] ===
                    NotificationDeliveryStatus.PENDING,
                )
                .map((r) => r.id),
              dto.type.trim(),
            )
          : null;
      const deliveryFor: DeliveryFor = dmPlan
        ? (id) => ({ ...planned(id), ...(dmPlan.get(id) ?? {}) })
        : planned;

      // (C4R3YyvH #5) Matn DISPATCH PAYTIDA qabul qiluvchi tilida
      // renderlanadi va qatorga yoziladi (SMS/Telegram/push shu matnni
      // oladi — yuborilgan matn o'zgarmas dalil). DB'da shablon yo'q — xom
      // DTO matni (o'rnatilgan 'uz' sukutlari dispatch'da QO'LLANMAYDI);
      // o'zgaruvchi yetishmasa — o'sha qabul qiluvchiga xom matn.
      const texts = await this.dispatchTexts(dto, targets);

      // 1) Persist one inbox row per recipient (the in_app channel & system of record).
      //    Push is only QUEUED here (outbox) — in the same transaction as the rows,
      //    so a rolled-back dispatch never sends a push. Delivery is async.
      //    Faqat `delivery.push = queued` qatorlar navbatga (obunasi yo'q /
      //    VAPID yo'q / o'chirilgan — outbox hodisasi yaratilmaydi).
      //    (xHPdpj0W) Kampaniya ilgaklari (before/afterPersist) qabul qiluvchi
      //    qolmasa ham ishlaydi — aks holda partiya da'vo qilinmay, kampaniya
      //    navbati to'xtab qolardi.
      let pushQueued = 0;
      let telegramQueued = 0;
      // (BOT-3c) Guruh relay'i (DM emas) — outbox qatorlari dispatch
      // tranzaksiyasi ichida; `undefined` — tranzaksiya ochilmadi.
      const wantsGroupRelay =
        channels.includes(NotificationChannel.TELEGRAM) &&
        !dmPlan &&
        Boolean(dto.telegram?.market_id || dto.telegram?.group_id);
      let relay: GroupRelay | undefined;
      const redelivery = { duplicate: false };
      const rows =
        !targets.length && !internal && !dedupKey
          ? []
          : await this.repo.manager.transaction(async (manager) => {
              if (
                dedupKey &&
                this.dedup &&
                !(await this.dedup.claim(manager, dedupKey))
              ) {
                redelivery.duplicate = true;
                return [];
              }
              await internal?.beforePersist?.(manager);
              const persisted = targets.length
                ? await this.persistRows(
                    manager,
                    dto,
                    targets,
                    channels,
                    deliveryFor,
                    dispatchId,
                    texts?.textFor,
                  )
                : [];
              const pushIds = persisted
                .filter(
                  (row) =>
                    row.delivery?.[NotificationChannel.PUSH] ===
                    NotificationDeliveryStatus.QUEUED,
                )
                .map((row) => row.id);
              if (pushIds.length) {
                await this.pushDelivery.enqueue(manager, pushIds);
              }
              pushQueued = pushIds.length;
              // (rCFZAmOz) Shaxsiy Telegram — faqat `delivery.telegram = queued`.
              if (dmPlan && this.telegramDm) {
                const dmIds = persisted
                  .filter(
                    (row) =>
                      row.delivery?.[NotificationChannel.TELEGRAM] ===
                      NotificationDeliveryStatus.QUEUED,
                  )
                  .map((row) => row.id);
                if (dmIds.length) await this.telegramDm.enqueue(manager, dmIds);
                telegramQueued = dmIds.length;
              }
              // SMS: navbatga ham shu tranzaksiyada; holat har qatorning delivery.sms ida.
              if (wantsSms && persisted.length) {
                smsResult = await this.queueSms(
                  persisted,
                  manager,
                  internal?.smsMessageClass,
                );
              }
              if (escalationDueAt && persisted.length && this.escalation) {
                await this.escalation.schedule(
                  manager,
                  persisted.map((row) => row.id),
                  escalationDueAt,
                );
              }
              if (wantsGroupRelay) {
                relay = await this.enqueueGroupRelay(manager, dto, persisted);
              }
              await internal?.afterPersist?.(manager, persisted);
              return persisted;
            });

      if (redelivery.duplicate) {
        return this.redeliveryResponse(dispatchId, channels);
      }

      // 2) Realtime (best-effort). Aniq qabul qiluvchilar — har biriga
      //    `user_id` emit; rol/broadcast — BITTA emit (QFoRULeu). Natija
      //    `delivery.realtime` ga: `emitted` (ack yo'q — `sent` EMAS) | `failed`.
      //    Realtime'ni o'chirgan qabul qiluvchilar (`skipped`) chiqarib tashlanadi.
      const realtimeRows = rows.filter(
        (row) =>
          row.delivery?.[NotificationChannel.REALTIME] ===
          NotificationDeliveryStatus.PENDING,
      );
      const realtime =
        channels.includes(NotificationChannel.REALTIME) && realtimeRows.length
          ? await this.pushRealtime(realtimeRows, dto, recipients)
          : null;

      // 3) Telegram relay (optional, best-effort) — natija `delivery.telegram`.
      let telegram: unknown = null;
      let telegramOutcome: TelegramOutcome | null = null;
      if (channels.includes(NotificationChannel.TELEGRAM) && !dmPlan) {
        if (wantsGroupRelay && !relay) {
          // Qatorsiz dispatch (tranzaksiya ochilmadi) — navbat alohida.
          relay = await this.repo.manager.transaction((manager) =>
            this.enqueueGroupRelay(manager, dto, []),
          );
        }
        const relayed = await this.relayTelegram(dto, relay);
        telegram = relayed.result;
        telegramOutcome = relayed.outcome;
      }

      // 4) Kanal natijalari dispatch oxirida BITTA bulk UPDATE bilan (sikl
      //    ichida save YO'Q). Email — provayder yo'q: `no_provider` qatorga
      //    INSERT paytida yozilgan (persistRows). (BOT-3c) Telegram `queued`
      //    tranzaksiyada yozilgan — yakunini outbox ishchisi yozadi (bu yerda
      //    qayta yozilsa, ishchining `sent` ini bosib ketishi mumkin edi).
      await this.recordDelivery(
        rows,
        realtime,
        telegramOutcome?.telegram === NotificationDeliveryStatus.QUEUED
          ? null
          : telegramOutcome,
      );

      // Audit: ONE row per dispatch operation (never one per recipient).
      await this.activityLog.log({
        entity_type: 'Notification',
        entity_id: dispatchId,
        action: 'notification.dispatched',
        user_id: actor?.id ? String(actor.id) : null,
        user_role: actor?.roles?.length ? actor.roles.join(',') : null,
        metadata: {
          dispatch_id: dispatchId,
          type: dto.type.trim(),
          category: dto.category ?? NotificationCategory.SYSTEM,
          dispatched_count: rows.length,
          skipped_by_preference: plan.skipped.size,
          channels,
          notification_ids: rows.slice(0, 20).map((row) => String(row.id)),
          ...(unresolved?.length
            ? { unresolved_count: unresolved.length }
            : {}),
        },
      });

      // (uFmUS86e) Kanal kesimidagi hisob: qaysi tashqi kanal haqiqatan
      // ketgani ko'rinadi — "Notification dispatched" faqat hammasi ketganda.
      const summary = this.summarizeChannels(
        channels,
        rows.length,
        realtime,
        telegramOutcome,
        smsResult as SmsChannelResult | null,
        pushQueued,
        // VAPID yo'q — planner qatorga `no_provider` yozadi (navbatga qo'ymaydi).
        rows.some(
          (row) =>
            row.delivery?.[NotificationChannel.PUSH] ===
            NotificationDeliveryStatus.NO_PROVIDER,
        ),
        dmPlan
          ? {
              queued: telegramQueued,
              noProvider: rows.some(
                (row) =>
                  row.delivery?.[NotificationChannel.TELEGRAM] ===
                  NotificationDeliveryStatus.NO_PROVIDER,
              ),
            }
          : null,
      );
      const message =
        !rows.length && plan.skipped.size
          ? 'Skipped by recipient preferences — nothing dispatched'
          : summary.message;

      // (7Vozou5x) Tarix yakuni + kanal × holat (inbox qatorlaridan, SMS
      // navbat natijasi ham) — javobga ham: `{ sms: { queued, not_eligible } }`.
      const channelStatus =
        historyId && this.history
          ? await this.history.finish(historyId, {
              status: historyStatusFor(
                summary.message,
                rows.length,
                plan.skipped.size,
              ),
              recipients: recipients.length,
              dispatched: rows.length,
              skipped_by_preference: plan.skipped.size,
              by_channel: summary.by_channel,
              no_provider: summary.no_provider,
              message,
            })
          : null;

      return successRes(
        {
          dispatch_id: dispatchId,
          dispatched: rows.length,
          recipient_ids: rows.map((r) => r.recipient_id),
          channels,
          telegram,
          // Kanal kesimidagi holat — quruq 201 emas (3fRbyadQ #7).
          delivery: {
            in_app: rows.length,
            ...(smsResult ?? {}),
            ...(realtime ? { realtime: realtime.emitted } : {}),
            ...(telegramOutcome
              ? { telegram_status: telegramOutcome.telegram }
              : {}),
          },
          by_channel: summary.by_channel,
          no_provider: summary.no_provider,
          // (aNynHYU0) tarixdagi bilan BIR xil holat (frontend o'zi hisoblamasin)
          // va kanal kesimi: full | partial | none.
          status: historyStatusFor(
            summary.message,
            rows.length,
            plan.skipped.size,
          ),
          channel_outcome: summary.channel_outcome,
          // (mP1WGG1W) Sozlama bilan tushib qolganlar — 400 emas, hisob.
          skipped_by_preference: plan.skipped.size,
          // (3SeRYFqx) identity'da topilmagan aniq recipient_id(s) — yozilmadi.
          ...(unresolved ? { unresolved } : {}),
          ...(channelStatus ? { channel_status: channelStatus } : {}),
          // (C4R3YyvH) Shablon qo'llangan bo'lsa: nechta qabul qiluvchiga,
          // qaysi tilda, nechtasiga xom matn (o'zgaruvchi yetishmadi).
          ...(texts ? { template: texts.stats } : {}),
        },
        201,
        message,
      );
    } catch (error) {
      if (historyId) await this.history?.fail(historyId, error);
      this.toRpcError(error);
    }
  }

  /**
   * (C4R3YyvH) Shablon matnlari. Render konteksti — `dto.data` + xom
   * `title`/`body`. Til — identity `contacts_by_ids` (faqat 'uz' dan boshqa
   * tilda shablon bo'lsa, bitta bulk RPC). Shablon servisi yo'q/xato —
   * null (xom matn, dispatch yiqilmaydi).
   */
  private async dispatchTexts(
    dto: DispatchNotificationDto,
    targets: ResolvedRecipient[],
  ): Promise<DispatchTexts | null> {
    if (!this.templates || !targets.length) return null;
    try {
      return await this.templates.forDispatch(
        dto.type.trim(),
        { ...(dto.data ?? {}), title: dto.title, body: dto.body ?? null },
        targets.map((r) => r.id),
        async (ids) => {
          const contacts = await this.smsDispatch.contacts(ids);
          return new Map(
            [...contacts.entries()].map(([id, c]) => [id, c.language ?? null]),
          );
        },
      );
    } catch (error) {
      this.logger.warn(`shablon qo'llanmadi (xom matn): ${shortReason(error)}`);
      return null;
    }
  }

  /** (7Vozou5x) Tarix uchun nishon sharti — ism/telefon EMAS, faqat shart. */
  private audienceSummary(
    dto: DispatchNotificationDto,
  ): Record<string, unknown> | null {
    const ids = [
      ...(dto.recipient_id ? [dto.recipient_id] : []),
      ...(dto.recipient_ids ?? []),
    ];
    const out: Record<string, unknown> = {
      ...(ids.length ? { recipient_ids: ids.length } : {}),
      // (NwlmrcMf) bitta odam — uning id'si (ism/telefon EMAS): «Kimga»
      // ustunida ism · rol chiziladi.
      ...(ids.length === 1 ? { recipient_id: String(ids[0]) } : {}),
      ...(dto.roles?.length ? { roles: dto.roles } : {}),
      ...(dto.broadcast ? { broadcast: true } : {}),
      ...(dto.include_customers ? { include_customers: true } : {}),
      ...(dto.segment ? { segment: dto.segment } : {}),
    };
    return Object.keys(out).length ? out : null;
  }

  /**
   * (7Ec56EIw / mP1WGG1W) Har qabul qiluvchi uchun boshlang'ich `delivery`.
   * Planner yo'q (eski unit spec'lar) — avvalgi xulq: hammaga bir xil.
   */
  private async planChannels(
    dto: DispatchNotificationDto,
    recipients: ResolvedRecipient[],
  ): Promise<ChannelPlanView> {
    const channels = requestedChannels(dto.type, dto.channels);
    if (!this.planner) {
      const delivery = this.initialDelivery(channels);
      return { deliveryFor: () => delivery, skipped: new Set() };
    }
    const plan = await this.planner.plan({
      type: dto.type.trim(),
      category: dto.category ?? NotificationCategory.SYSTEM,
      priority: dto.priority ?? NotificationPriority.NORMAL,
      requested: dto.channels,
      recipientIds: recipients.map((r) => r.id),
    });
    const fallback = this.initialDelivery(plan.channels);
    return {
      deliveryFor: (id) => plan.byRecipient.get(id)?.delivery ?? fallback,
      skipped: new Set(plan.skippedByPreference),
    };
  }

  /**
   * SMS navbati — faqat `delivery.sms = pending` qatorlar (telefoni yo'q —
   * `not_eligible`, o'chirgan — `skipped`; ular SMS servisiga bormaydi).
   */
  private async queueSms(
    rows: Notification[],
    manager: EntityManager,
    messageClass?: 'promo',
  ): Promise<SmsChannelResult> {
    const eligible = rows.filter(
      (row) =>
        row.delivery?.[NotificationChannel.SMS] ===
        NotificationDeliveryStatus.PENDING,
    );
    const skipped = rows.length - eligible.length;
    if (!eligible.length) {
      const reason = rows.find(
        (row) => row.delivery?.[`${NotificationChannel.SMS}_reason`],
      )?.delivery?.[`${NotificationChannel.SMS}_reason`];
      return {
        sms: 0,
        sms_status: 'skipped',
        sms_reason: typeof reason === 'string' ? reason : 'not_eligible',
        sms_skipped: skipped,
      };
    }
    const result = messageClass
      ? await this.smsDispatch.queueForNotifications(eligible, manager, {
          messageClass,
        })
      : await this.smsDispatch.queueForNotifications(eligible, manager);
    if (!skipped) return result;
    return {
      ...result,
      sms_status:
        result.sms_status === 'queued' ? 'partial' : result.sms_status,
      sms_skipped: (result.sms_skipped ?? 0) + skipped,
    };
  }

  private async resolveRecipients(
    dto: DispatchNotificationDto,
  ): Promise<ResolvedRecipient[]> {
    const map = new Map<string, ResolvedRecipient>();

    if (dto.recipient_id) {
      map.set(dto.recipient_id, {
        id: dto.recipient_id,
        role: null,
        via: 'explicit',
      });
    }

    for (const id of dto.recipient_ids ?? []) {
      const clean = String(id ?? '').trim();
      if (clean) map.set(clean, { id: clean, role: null, via: 'explicit' });
    }

    // (W8aerwL6) Rol/broadcast/mijoz nishoni — yangi `identity.audience.resolve`
    // (superadmin va mijoz ham). Mijoz qoidalari (TC6/TC7) shu yerda.
    const target = buildAudienceTarget(dto);
    if (target) await this.collectFromIdentity(target, map);

    // (QFoRULeu) Chegaradan oshsa XATO — jimgina kesilgan kampaniya
    // "muvaffaqiyat" deb yozilmasin. Yig'ish MAX_FANOUT+1 da to'xtaydi,
    // shuning uchun oshib ketish aniq ko'rinadi.
    if (map.size > MAX_FANOUT) {
      throw new BadRequestException(
        `fan-out cap exceeded: qabul qiluvchilar ${MAX_FANOUT} tadan ko'p (MAX_FANOUT). ` +
          'Nishonni toraytiring (roles/recipient_ids) — hech narsa yuborilmadi.',
      );
    }
    return Array.from(map.values());
  }

  /**
   * (W8aerwL6) Auditoriyani `identity.audience.resolve` dan keyset sahifalab
   * `map` ga yig'adi. Avval `identity.user.find_all` edi — u superadmin va
   * mijozni ataylab chiqarib tashlaydi (GET /users xavfsizligi, unga
   * TEGILMAYDI), shuning uchun `roles:['customer'|'superadmin']` 0 qaytarardi.
   *
   * ⚠️ PII: `fields: 'minimal'` — faqat id/rol/til; ism va telefon bu
   * servis xotirasiga va log'iga tushmaydi. ⚠️ identity xatosi endi
   * YUTILMAYDI (ilgari warn + to'xtash — yarim auditoriyaga "muvaffaqiyat").
   */
  private async collectFromIdentity(
    target: IdentityAudienceTarget,
    map: Map<string, ResolvedRecipient>,
  ) {
    let afterId: string | null = null;
    // Yagona rol so'ralgan bo'lsa — javobda rol bo'lmasa ham o'sha rol.
    const onlyRole =
      !target.broadcast &&
      !target.include_customers &&
      target.roles?.length === 1
        ? target.roles[0]
        : null;

    while (true) {
      if (map.size > MAX_FANOUT) return;
      let res: unknown;
      try {
        res = await rmqSend<unknown>(
          this.identityClient,
          { cmd: AUDIENCE_RESOLVE_PATTERN },
          {
            ...target,
            after_id: afterId,
            limit: IDENTITY_PAGE_SIZE,
            fields: 'minimal',
            with_total: false,
          },
        );
      } catch (error) {
        throw audienceRpcError(error);
      }

      const page = toAudiencePage(res);
      if (!page.items.length) return;

      let lastId: string | null = null;
      for (const u of page.items) {
        const id = String(u?.id ?? '').trim();
        if (id) {
          lastId = id;
          map.set(id, { id, role: u?.role ?? onlyRole, via: 'identity' });
          if (map.size > MAX_FANOUT) return;
        }
      }

      if (page.items.length < IDENTITY_PAGE_SIZE) return;
      const next = page.next_after_id ?? lastId;
      // Kursor oldinga siljimasa — cheksiz sikl emas, to'xtaymiz.
      if (!next || next === afterId) return;
      afterId = next;
    }
  }

  /**
   * Bitta dispatch — o'zgarmas sondagi so'rov (qabul qiluvchilar soniga
   * bog'liq emas): group_key bo'yicha bitta qidiruv, rol bo'yicha UPDATE,
   * 500 tadan bulk INSERT va bitta qayta o'qish. Avval har qabul qiluvchi
   * uchun alohida `findOne` + `save` edi (40 ta = 80 so'rov).
   */
  private async persistRows(
    manager: EntityManager,
    dto: DispatchNotificationDto,
    recipients: ResolvedRecipient[],
    channels: NotificationChannel[],
    deliveryFor: DeliveryFor = () => this.initialDelivery(channels),
    dispatchId: string | null = null,
    textFor: TextFor = () => null,
  ): Promise<Notification[]> {
    const repo = manager.getRepository(Notification);
    const base = {
      // (7Vozou5x) Qator o'z partiyasiga bog'lanadi (tarix tafsiloti).
      dispatch_id: dispatchId,
      type: dto.type.trim(),
      category: dto.category ?? NotificationCategory.SYSTEM,
      priority: dto.priority ?? NotificationPriority.NORMAL,
      title: dto.title.trim(),
      body: dto.body ?? null,
      data: dto.data ?? null,
      link: dto.link ?? null,
      channels,
      group_key: dto.group_key ?? null,
    };
    // (uFmUS86e) Har so'ralgan kanal uchun boshlang'ich holat — qator
    // yozilgan zahoti "kimga nima ketmagani" DB'da ko'rinadi. (7Ec56EIw)
    // Endi qabul qiluvchi bo'yicha: o'chirilgan / imkoniyati yo'q kanal.

    const rowIdByRecipient = new Map<string, string>();
    /** (A1HzKEby) Birlashtiriladigan qatorning hozirgi data.count i. */
    const countByRecipient = new Map<string, number>();
    let toInsert = recipients;

    // Dedupe by group_key: refresh the existing row instead of stacking dupes.
    if (dto.group_key) {
      const existing = await repo.find({
        where: {
          recipient_id: In(recipients.map((r) => r.id)),
          group_key: dto.group_key,
          isDeleted: false,
        },
      });
      for (const row of existing) {
        const key = String(row.recipient_id);
        if (!rowIdByRecipient.has(key)) {
          rowIdByRecipient.set(key, row.id);
          countByRecipient.set(key, eventCount(row.data));
        }
      }
    }

    // (A1HzKEby #4) Bo'ron chegarasi: group_key bo'yicha qatori yo'q, lekin
    // shu turdan oxirgi 1 soatda chegaradan ko'p qatori bor qabul qiluvchi —
    // yangi qator EMAS, eng oxirgi qatori yangilanadi (data.count oshadi).
    await this.applyHourlyCap(
      repo,
      dto,
      recipients.filter((r) => !rowIdByRecipient.has(r.id)),
      rowIdByRecipient,
      countByRecipient,
    );

    if (rowIdByRecipient.size) {
      // Bir xil rol + bir xil boshlang'ich `delivery` — BITTA UPDATE.
      const groups = new Map<
        string,
        {
          role: string | null;
          delivery: Record<string, string>;
          text: { title: string; body: string | null } | null;
          count: number;
          ids: string[];
        }
      >();
      for (const recipient of recipients) {
        const rowId = rowIdByRecipient.get(recipient.id);
        if (!rowId) continue;
        const delivery = deliveryFor(recipient.id);
        const text = textFor(recipient.id);
        // (A1HzKEby) Shu qatorga yig'ilgan hodisalar: oldingi + shu dispatch.
        const count = (countByRecipient.get(recipient.id) ?? 1) + 1;
        const key = JSON.stringify([recipient.role, delivery, text, count]);
        const group = groups.get(key) ?? {
          role: recipient.role,
          delivery,
          text,
          count,
          ids: [],
        };
        group.ids.push(rowId);
        groups.set(key, group);
      }
      for (const { role, delivery, text, count, ids } of groups.values()) {
        // jsonb ustunlari (`data`, `delivery`) TypeORM deep-partial turiga sig'maydi.
        await repo.update({ id: In(ids) }, {
          ...base,
          ...(text ?? {}),
          // (A1HzKEby) data — oxirgi hodisaniki, count — yig'ilgan hodisalar
          // soni (frontend: "N ta yangilanish"). Yangi qatorda count yo'q = 1.
          data: { ...(dto.data ?? {}), count },
          delivery,
          recipient_role: role,
          is_read: false,
          read_at: null,
          /**
           * (OA16fdSq / QFoRULeu — inbox-group-sort) Guruh qatorining
           * yangilanishi — YANGI hodisa: inbox saralash kaliti `createdAt`
           * ham yangilanadi, aks holda qator (masalan "bekor qilindi")
           * birinchi hodisa vaqti bilan ro'yxat PASTIDA qolib ketardi. Vaqt
           * — DB soati (`CURRENT_TIMESTAMP` = tranzaksiya boshi), xuddi shu
           * dispatch'da INSERT qilingan qatorlarning `DEFAULT now()` i bilan
           * bir xil. `updatedAt` bo'yicha saralash EMAS: u o'qildi belgisi,
           * `delivery` yozuvi va o'chirishda ham o'zgaradi (qator sababsiz
           * tepaga sakrardi) va `(recipient_id, updatedAt)` indeksi yo'q.
           */
          createdAt: () => 'CURRENT_TIMESTAMP',
        } as QueryDeepPartialEntity<Notification>);
      }
      toInsert = recipients.filter((r) => !rowIdByRecipient.has(r.id));
    }

    for (let start = 0; start < toInsert.length; start += INSERT_CHUNK) {
      const batch = toInsert.slice(start, start + INSERT_CHUNK);
      const result = await repo.insert(
        batch.map((recipient) =>
          repo.create({
            ...base,
            ...(textFor(recipient.id) ?? {}),
            delivery: deliveryFor(recipient.id),
            recipient_id: recipient.id,
            recipient_role: recipient.role,
            is_read: false,
            read_at: null,
          }),
        ) as QueryDeepPartialEntity<Notification>[],
      );
      result.identifiers.forEach((identifier, index) => {
        rowIdByRecipient.set(batch[index].id, String(identifier.id));
      });
    }

    const ids = recipients
      .map((r) => rowIdByRecipient.get(r.id))
      .filter((id): id is string => Boolean(id));
    const rows: Notification[] = [];
    for (let start = 0; start < ids.length; start += READ_CHUNK) {
      rows.push(
        ...(await repo.find({
          where: { id: In(ids.slice(start, start + READ_CHUNK)) },
        })),
      );
    }
    const order = new Map(ids.map((id, index) => [id, index]));
    return rows.sort(
      (a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0),
    );
  }

  /**
   * (A1HzKEby #4) BO'RON CHEGARASI. Qabul qiluvchida shu TURDAN oxirgi 1
   * soatda (DB soati) NOTIF_HOURLY_CAP_PER_TYPE ta yoki ko'p qator bo'lsa —
   * yangi qator yozilmaydi: eng oxirgi qatori yangilanadi (mazmun — yangi
   * hodisa, data.count oshadi, qayta o'qilmagan bo'ladi). BITTA so'rov
   * (1000 tadan bo'lak), IDX_NOTIF_RECIPIENT_CREATED bo'yicha.
   *
   * CRITICAL — chegarasiz (xavfsizlik xabari yig'ilib yo'qolmasin, eskalatsiya
   * har qatorga). Siyosat yo'q (eski unit spec'lar) yoki 0 — o'chiq.
   */
  private async applyHourlyCap(
    repo: Repository<Notification>,
    dto: DispatchNotificationDto,
    candidates: ResolvedRecipient[],
    rowIdByRecipient: Map<string, string>,
    countByRecipient: Map<string, number>,
  ): Promise<void> {
    const cap = this.policy?.hourlyCapPerType ?? 0;
    if (
      !cap ||
      !candidates.length ||
      dto.priority === NotificationPriority.CRITICAL
    ) {
      return;
    }
    for (let start = 0; start < candidates.length; start += READ_CHUNK) {
      const ids = candidates
        .slice(start, start + READ_CHUNK)
        .map((recipient) => recipient.id);
      const rows = await repo
        .createQueryBuilder('n')
        .select('n.recipient_id', 'recipient_id')
        .addSelect('n.id', 'id')
        .addSelect("n.data ->> 'count'", 'count')
        .addSelect('COUNT(*) OVER (PARTITION BY n.recipient_id)', 'recent')
        .distinctOn(['n.recipient_id'])
        .where('n.recipient_id IN (:...ids)', { ids })
        .andWhere('n.type = :type', { type: dto.type.trim() })
        .andWhere('n.isDeleted = false')
        .andWhere("n.createdAt > now() - interval '1 hour'")
        .orderBy('n.recipient_id')
        .addOrderBy('n.createdAt', 'DESC')
        .addOrderBy('n.id', 'DESC')
        .getRawMany<{
          recipient_id: string;
          id: string;
          count: string | null;
          recent: string;
        }>();
      for (const row of rows) {
        const key = String(row.recipient_id);
        if (Number(row.recent) < cap || rowIdByRecipient.has(key)) continue;
        rowIdByRecipient.set(key, String(row.id));
        countByRecipient.set(key, eventCount({ count: row.count }));
      }
    }
  }

  /**
   * Boshlang'ich `delivery`: in_app darhol `sent` (qatorning o'zi), push
   * `queued`, email `no_provider`, qolganlar `pending` (resolve-channels.ts).
   */
  private initialDelivery(channels: NotificationChannel[]) {
    const delivery: Record<string, string> = {
      [NotificationChannel.IN_APP]: NotificationDeliveryStatus.SENT,
    };
    for (const channel of channels) {
      if (channel === NotificationChannel.IN_APP) continue;
      delivery[channel] = initialChannelStatus(channel);
    }
    return delivery;
  }

  /**
   * Realtime (QFoRULeu): aniq qabul qiluvchilar (`recipient_id(s)`) — har
   * biriga `user_id` emit (to'liq qator payload'i); rol bo'yicha — har rolga
   * BITTA emit, broadcast — BITTA emit. Guruh emit'ida qator id'si yo'q,
   * frontend "inboxni yangilash" signalini oladi (`{ type, category, priority }`)
   * va qatorni `GET /notifications/inbox` dan o'qiydi.
   *
   * ⚠️ Har emit `timeout(2_000)` bilan chegaralangan va aniq qabul
   * qiluvchilar 50 tadan PARALLEL yuboriladi. Ketma-ket `await` + timeout
   * naqshi Web Push / SMS ga NUSXALANMASIN — ular tashqi HTTP (yuzlab ms) va
   * outbox orqali ketadi.
   */
  private async pushRealtime(
    rows: Notification[],
    dto: DispatchNotificationDto,
    recipients: ResolvedRecipient[],
  ): Promise<RealtimeResult> {
    const outcomes = new Map<string, DeliveryPatch>();
    const viaIdentity = new Set(
      recipients
        .filter((recipient) => recipient.via === 'identity')
        .map((recipient) => recipient.id),
    );
    const direct = rows.filter(
      (row) => !viaIdentity.has(String(row.recipient_id)),
    );
    const grouped = rows.filter((row) =>
      viaIdentity.has(String(row.recipient_id)),
    );
    const signal = {
      type: dto.type.trim(),
      category: dto.category ?? null,
      priority: dto.priority ?? null,
    };

    const directResults = await this.emitEach(direct);
    direct.forEach((row, index) =>
      outcomes.set(String(row.id), directResults[index]),
    );

    if (grouped.length) {
      const targets = new Map<string, Notification[]>();
      for (const row of grouped) {
        const key = dto.broadcast
          ? '*'
          : String(row.recipient_role ?? '').toLowerCase();
        targets.set(key, [...(targets.get(key) ?? []), row]);
      }
      for (const [key, targetRows] of targets) {
        if (!key) {
          // Rolsiz (identity rol bermagan) — xona yo'q, faqat user_id.
          const results = await this.emitEach(targetRows);
          targetRows.forEach((row, index) =>
            outcomes.set(String(row.id), results[index]),
          );
          continue;
        }
        const result = await this.emitRealtime(
          key === '*'
            ? { event: 'notification:new', broadcast: true, payload: signal }
            : { event: 'notification:new', role: key, payload: signal },
        );
        for (const row of targetRows) outcomes.set(String(row.id), result);
      }
    }

    let emitted = 0;
    for (const outcome of outcomes.values()) {
      if (outcome.realtime === NotificationDeliveryStatus.EMITTED) emitted += 1;
    }
    return { outcomes, emitted };
  }

  /** Har qatorga `user_id` emit — 50 tadan parallel (ketma-ket emas). */
  private async emitEach(rows: Notification[]): Promise<DeliveryPatch[]> {
    const results: DeliveryPatch[] = [];
    for (let start = 0; start < rows.length; start += REALTIME_CONCURRENCY) {
      results.push(
        ...(await Promise.all(
          rows.slice(start, start + REALTIME_CONCURRENCY).map((row) =>
            this.emitRealtime({
              event: 'notification:new',
              user_id: row.recipient_id,
              payload: this.toPublic(row),
            }),
          ),
        )),
      );
    }
    return results;
  }

  private async emitRealtime(message: object): Promise<DeliveryPatch> {
    try {
      await lastValueFrom(
        this.gatewayClient
          .emit({ cmd: 'realtime.notify' }, message)
          // Sekin/javobsiz broker butun dispatch'ni to'xtatib qo'ymasin.
          .pipe(timeout(2_000)),
        { defaultValue: null },
      );
      return { realtime: NotificationDeliveryStatus.EMITTED };
    } catch (err) {
      const reason = shortReason(err);
      this.logger.warn(`realtime push failed: ${reason}`);
      return {
        realtime: NotificationDeliveryStatus.FAILED,
        realtime_error: reason,
      };
    }
  }

  /**
   * Telegram relay (uFmUS86e / n0kLbx3d). Natija `delivery.telegram` ga:
   * `sent` (Telegram API `ok`) | `failed` + `telegram_error` (≤200 belgi) |
   * `not_eligible` (nishon yo'q / marketda guruh ulanmagan).
   *
   * ⚠️ Bot tokeni payload'dan ham, DB'dan ham OLINMAYDI — faqat env
   * (TELEGRAM_BOT_TOKEN, bOMYoOtV). Matn `parse_mode: HTML`: chaqiruvchi tayyor
   * `telegram.text` bermasa sarlavha/tana HTML-escape qilinadi (`<`/`&`
   * bo'lsa Telegram butun xabarni rad etardi).
   */
  /**
   * (BOT-3c) Guruh relay'ini dispatch tranzaksiyasi ichida navbatga qo'yadi
   * va qatorlarga `delivery.telegram = queued` yozadi (rollback → ikkalasi
   * ham yo'q). Guruh yo'q — `null` (not_eligible). Xato — `{ error }`:
   * tranzaksiya buzilmagan bo'lsa dispatch davom etadi (relay best-effort).
   */
  private async enqueueGroupRelay(
    manager: EntityManager,
    dto: DispatchNotificationDto,
    persisted: Notification[],
  ): Promise<GroupRelay> {
    const target = dto.telegram!;
    const notificationIds = persisted.map((row) => String(row.id));
    // SAVEPOINT: relay xatosi (statement / lock timeout, ustun yo'q …)
    // dispatch tranzaksiyasini ABORT qilmasin — aks holda COMMIT jimgina
    // ROLLBACK bo'lib, inbox qatorlari, push/SMS/DM navbati, eskalatsiya va
    // dedup kaliti yo'qolardi, javob esa baribir «dispatched» edi.
    await manager.query('SAVEPOINT "telegram_relay"');
    try {
      const ids = await this.telegramService.enqueueGroupRelay(
        manager,
        {
          market_id: target.market_id,
          group_id: target.group_id,
          group_type: target.group_type,
        },
        this.relayMessage(dto),
        notificationIds,
      );
      if (ids && notificationIds.length) {
        await manager.query(
          `UPDATE "notification_schema"."notifications"
              SET "delivery" = COALESCE("delivery", '{}'::jsonb) || '{"telegram":"queued"}'::jsonb
            WHERE "id" = ANY($1::bigint[])`,
          [notificationIds],
        );
      }
      await manager.query('RELEASE SAVEPOINT "telegram_relay"');
      return { ids };
    } catch (error) {
      // Faqat relay qismi bekor; dispatch tranzaksiyasi davom etadi. Savepoint
      // ham tiklanmasa — tranzaksiya buzilgan: xato chaqiruvchiga (rollback,
      // RMQ qayta yetkazadi), «dispatched» deb aytilmaydi.
      await manager.query('ROLLBACK TO SAVEPOINT "telegram_relay"');
      this.logger.warn(
        `telegram relay navbatga qo'yilmadi (dispatch davom etadi): ${shortReason(error)}`,
      );
      return { ids: null, error };
    }
  }

  private relayMessage(dto: DispatchNotificationDto): string {
    const target = dto.telegram;
    const message =
      typeof target?.text === 'string' && target.text.trim()
        ? target.text
        : dto.body
          ? `${escapeTelegramHtml(dto.title)}\n\n${escapeTelegramHtml(dto.body)}`
          : escapeTelegramHtml(dto.title);
    return message.slice(0, 4096);
  }

  private async relayTelegram(
    dto: DispatchNotificationDto,
    relay: GroupRelay | undefined,
  ): Promise<{ result: unknown; outcome: TelegramOutcome }> {
    const target = dto.telegram;
    if (!relay || (!target?.market_id && !target?.group_id)) {
      return {
        result: null,
        outcome: {
          telegram: NotificationDeliveryStatus.NOT_ELIGIBLE,
          telegram_error: 'telegram_target_missing',
        },
      };
    }
    try {
      if (relay.error) {
        throw relay.error instanceof Error
          ? relay.error
          : new Error(String(relay.error));
      }
      if (!relay.ids) {
        throw new RpcException({
          statusCode: 404,
          message: 'Telegram target group not found for market',
        });
      }
      const res = (await this.telegramService.flushGroupRelay(relay.ids)) as {
        data?: {
          success?: number;
          failed?: number;
          queued?: number;
          results?: Array<{ ok?: boolean; queued?: boolean; error?: string }>;
        };
      } | null;
      const data = res?.data ?? {};
      const success = Number(data.success ?? 0);
      const failed = Number(data.failed ?? 0);
      // (9HIaV80X) 429/5xx — telegram_outbox qayta yuboradi: xato emas.
      const queued = Number(data.queued ?? 0);
      const firstError =
        data.results?.find((item) => !item.ok && !item.queued)?.error ??
        'telegram_failed';
      const outcome: TelegramOutcome =
        failed === 0 && success > 0 && queued === 0
          ? {
              telegram: NotificationDeliveryStatus.SENT,
              telegram_sent: success,
            }
          : failed === 0 && queued > 0
            ? {
                telegram: NotificationDeliveryStatus.QUEUED,
                telegram_sent: success,
              }
            : {
                telegram: NotificationDeliveryStatus.FAILED,
                telegram_sent: success,
                telegram_error: shortReason(
                  success > 0
                    ? `partial ${failed}/${success + failed}: ${firstError}`
                    : firstError,
                ),
              };
      return { result: res, outcome };
    } catch (err) {
      const rpc =
        err instanceof RpcException
          ? (err.getError() as { statusCode?: number; message?: string })
          : null;
      const reason = shortReason(rpc?.message ?? err);
      this.logger.warn(`telegram relay failed: ${reason}`);
      const outcome: TelegramOutcome =
        rpc?.statusCode === 404
          ? {
              telegram: NotificationDeliveryStatus.NOT_ELIGIBLE,
              telegram_error: 'no_telegram_group',
            }
          : {
              telegram: NotificationDeliveryStatus.FAILED,
              telegram_error: reason,
            };
      return { result: { ok: false, status: outcome.telegram }, outcome };
    }
  }

  /**
   * Realtime + Telegram natijalarini qatorlarga yozadi —
   * `UPDATE ... WHERE id IN (...)`: bir xil natijali qatorlar BITTA so'rovda
   * (odatda hammasi bir xil → jami 1 ta UPDATE). Sikl ichida save YO'Q.
   * Best-effort: xato bo'lsa faqat log — qatorlar va kanallar allaqachon ketgan.
   */
  private async recordDelivery(
    rows: Notification[],
    realtime: RealtimeResult | null,
    telegram: TelegramOutcome | null,
  ): Promise<void> {
    if (!rows.length || (!realtime && !telegram)) return;
    const groups = new Map<string, { patch: DeliveryPatch; ids: string[] }>();
    for (const row of rows) {
      const patch: DeliveryPatch = {
        ...(realtime?.outcomes.get(String(row.id)) ?? {}),
        ...(telegram ?? {}),
      };
      const key = JSON.stringify(patch);
      const group = groups.get(key) ?? { patch, ids: [] };
      group.ids.push(String(row.id));
      groups.set(key, group);
    }
    try {
      for (const { patch, ids } of groups.values()) {
        await this.repo
          .createQueryBuilder()
          .update(Notification)
          .set({
            delivery: () =>
              `COALESCE("delivery", '{}'::jsonb) || :patch::jsonb`,
          })
          .setParameter('patch', JSON.stringify(patch))
          .whereInIds(ids)
          .execute();
      }
    } catch (err) {
      this.logger.error(
        `delivery holatini yozib bo'lmadi (${rows.length} qator): ${shortReason(err)}`,
      );
    }
  }

  /**
   * Javob uchun kanal kesimi (uFmUS86e): `by_channel` — haqiqatan ketgan son,
   * `no_provider` — provayderi yo'q kanallar. Xabar matni: hammasi ketdi →
   * `Notification dispatched`; bir qismi → `Partially dispatched`; hech bir
   * tashqi kanal ketmadi → "dispatched"/"sent" demaydi.
   */
  private summarizeChannels(
    channels: NotificationChannel[],
    rows: number,
    realtime: RealtimeResult | null,
    telegram: TelegramOutcome | null,
    sms: SmsChannelResult | null,
    pushQueued = rows,
    pushNoProvider = false,
    /** (rCFZAmOz) Shaxsiy DM yo'li: navbatga qo'yilganlar (guruh relay emas). */
    telegramDm: { queued: number; noProvider: boolean } | null = null,
  ) {
    const byChannel: Record<string, number> = { in_app: rows };
    const noProvider: string[] = [];
    for (const channel of channels) {
      if (channel === NotificationChannel.REALTIME) {
        byChannel.realtime = realtime?.emitted ?? 0;
      } else if (channel === NotificationChannel.TELEGRAM) {
        byChannel.telegram = telegramDm
          ? telegramDm.queued
          : Number(telegram?.telegram_sent ?? 0);
        if (telegramDm?.noProvider) noProvider.push(channel);
      } else if (channel === NotificationChannel.SMS) {
        byChannel.sms = Number(sms?.sms ?? 0);
        if (sms?.sms_status === 'no_provider') noProvider.push(channel);
      } else if (channel === NotificationChannel.PUSH) {
        // Navbatga qo'yilganlar (obunasi bor) — hammasi emas.
        byChannel.push = pushQueued;
        if (pushNoProvider) noProvider.push(channel);
      } else if (channel === NotificationChannel.EMAIL) {
        byChannel.email = 0;
        noProvider.push(channel);
      }
    }
    const external = channels.filter(
      (channel) => channel !== NotificationChannel.IN_APP,
    );
    // (aNynHYU0) Kanal TO'LIQ — har bir qabul qiluvchiga ketgan (`son >=
    // qatorlar`), QISMAN — bir qismiga, YO'Q — hech kimga. Ilgari `son > 0`
    // yetardi: 100 dan 1 kishiga ketgan SMS ham «yuborildi» (sent) edi.
    // Telegram guruh relay'i (DM emas) qabul qiluvchi bo'yicha emas — >0 = to'liq.
    const outcome: Record<string, 'full' | 'partial' | 'none'> = {};
    for (const channel of external) {
      const reached = Number(byChannel[channel] ?? 0);
      const groupRelay =
        channel === NotificationChannel.TELEGRAM && !telegramDm;
      outcome[channel] =
        reached <= 0
          ? 'none'
          : groupRelay || (reached >= rows && !noProvider.includes(channel))
            ? 'full'
            : 'partial';
    }
    const reachedAny = external.filter(
      (channel) => outcome[channel] !== 'none',
    );
    const message = external.every((channel) => outcome[channel] === 'full')
      ? 'Notification dispatched'
      : reachedAny.length
        ? 'Partially dispatched'
        : 'Saved to inbox only — no external channel delivered';
    return {
      by_channel: byChannel,
      no_provider: noProvider,
      channel_outcome: outcome,
      message,
    };
  }

  /** `GET /notifications/types` (Eh8y21Ha) — kod katalogi, DB emas. */
  listTypes() {
    return successRes(
      {
        items: NOTIFICATION_TYPES,
        free_prefix: FREE_NOTIFICATION_TYPE_PREFIX,
        categories: Object.values(NotificationCategory),
      },
      200,
      'Notification types',
    );
  }

  // ==================== INBOX READS (per recipient) ====================

  async list(dto: ListNotificationsDto) {
    try {
      this.assertId(dto.recipient_id, 'recipient_id');
      const page = Number(dto.page) > 0 ? Number(dto.page) : 1;
      const limit =
        Number(dto.limit) > 0 ? Math.min(Number(dto.limit), 100) : 20;

      const where: FindOptionsWhere<Notification> = {
        recipient_id: dto.recipient_id,
        isDeleted: false,
      };
      if (dto.is_read !== undefined) where.is_read = dto.is_read;
      if (dto.type) where.type = dto.type;
      if (dto.category) where.category = dto.category;
      if (dto.important) where.priority = In([...IMPORTANT_PRIORITIES]);
      else if (dto.priority) where.priority = dto.priority;

      const [items, total] = await this.repo.findAndCount({
        where,
        // (inbox-group-sort) `createdAt` — oxirgi hodisa vaqti (guruh
        // yangilanganda ham o'zgaradi, persistRows). `id` — teng vaqtlarda
        // barqaror tartib: sahifalar orasida qator takrorlanmaydi/tushib
        // qolmaydi (IDX_NOTIF_RECIPIENT_CREATED indeksi ishlatiladi).
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });

      const unread = await this.repo.count({
        where: {
          recipient_id: dto.recipient_id,
          isDeleted: false,
          is_read: false,
        },
      });

      return successRes(
        {
          items: items.map((row) => this.toPublic(row)),
          unread,
          meta: {
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
          },
        },
        200,
        'Notifications',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findOne(recipientId: string, id: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      this.assertId(id, 'id');
      const row = await this.requireOwned(recipientId, id);
      return successRes(this.toPublic(row), 200, 'Notification');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * INBOX SANOQLARI (n1sNvGLn) — kategoriya chiplari uchun. BITTA
   * `GROUP BY` so'rov: har kategoriyada jami va o'qilmaganlar, hamda muhim
   * (critical/high) o'qilmaganlar. Sanoq hech qachon joriy sahifadagi 20
   * qatordan hisoblanmaydi — chip butun inbox bo'yicha raqam ko'rsatadi.
   */
  async counts(recipientId: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      const rows = await this.repo
        .createQueryBuilder('n')
        .select('n.category', 'category')
        .addSelect('COUNT(*)', 'total')
        .addSelect('COUNT(*) FILTER (WHERE n.is_read = false)', 'unread')
        .addSelect(
          'COUNT(*) FILTER (WHERE n.is_read = false AND n.priority IN (:...important))',
          'important_unread',
        )
        .where('n.recipient_id = :rid', { rid: recipientId })
        .andWhere('n.isDeleted = false')
        .setParameter('important', [...IMPORTANT_PRIORITIES])
        .groupBy('n.category')
        .getRawMany<{
          category: string;
          total: string;
          unread: string;
          important_unread: string;
        }>();

      const categories: Record<string, { total: number; unread: number }> = {};
      for (const category of Object.values(NotificationCategory)) {
        categories[category] = { total: 0, unread: 0 };
      }
      let unread = 0;
      let importantUnread = 0;
      for (const row of rows) {
        categories[row.category] = {
          total: Number(row.total ?? 0),
          unread: Number(row.unread ?? 0),
        };
        unread += Number(row.unread ?? 0);
        importantUnread += Number(row.important_unread ?? 0);
      }

      return successRes(
        { categories, unread, important_unread: importantUnread },
        200,
        'Inbox counts',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async unreadCount(recipientId: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      const unread = await this.repo.count({
        where: { recipient_id: recipientId, isDeleted: false, is_read: false },
      });
      return successRes({ unread }, 200, 'Unread count');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async markRead(recipientId: string, id: string, read = true) {
    try {
      this.assertId(recipientId, 'recipient_id');
      this.assertId(id, 'id');
      const row = await this.requireOwned(recipientId, id);
      row.is_read = read;
      row.read_at = read ? new Date() : null;
      const saved = await this.repo.save(row);
      return successRes(
        this.toPublic(saved),
        200,
        read ? 'Marked read' : 'Marked unread',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async markAllRead(recipientId: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      const result = await this.repo.update(
        { recipient_id: recipientId, isDeleted: false, is_read: false },
        { is_read: true, read_at: new Date() },
      );
      return successRes(
        { updated: result.affected ?? 0 },
        200,
        'All marked read',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async remove(recipientId: string, id: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      this.assertId(id, 'id');
      const row = await this.requireOwned(recipientId, id);
      row.isDeleted = true;
      await this.repo.save(row);
      return successRes({ id }, 200, 'Notification deleted');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  // ==================== helpers ====================

  private assertId(value: string | undefined, field: string) {
    if (!value || !/^\d+$/.test(String(value))) {
      throw new BadRequestException(
        `${field} must be a bigint-like numeric string`,
      );
    }
  }

  private async requireOwned(
    recipientId: string,
    id: string,
  ): Promise<Notification> {
    const row = await this.repo.findOne({
      where: { id, recipient_id: recipientId, isDeleted: false },
    });
    if (!row) throw new NotFoundException('Notification not found');
    return row;
  }

  private toPublic(row: Notification) {
    return {
      id: row.id,
      recipient_id: row.recipient_id,
      recipient_role: row.recipient_role,
      type: row.type,
      category: row.category,
      priority: row.priority,
      title: row.title,
      body: row.body,
      data: row.data,
      link: row.link,
      is_read: row.is_read,
      read_at: row.read_at,
      // (inbox-group-sort) group_key qatorida — OXIRGI hodisa vaqti.
      created_at: row.createdAt,
      // (uFmUS86e) Kanal natijalari inbox javobida ham — qo'shimcha maydon,
      // eski frontend uni e'tiborsiz qoldiradi.
      delivery: row.delivery ?? null,
    };
  }
}
