import {
  BadRequestException,
  Inject,
  Injectable,
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
  isKnownNotificationType,
  maskPhonesForLog,
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

/** Qabul qiluvchi bo'yicha boshlang'ich `delivery` (kanal rejasi, 7Ec56EIw). */
type DeliveryFor = (recipientId: string) => Record<string, string>;

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
@Injectable()
export class NotificationInboxService {
  private readonly logger = new Logger(NotificationInboxService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('GATEWAY') private readonly gatewayClient: ClientProxy,
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

  /** Dispatch partiyasi ID si (f2Ud5tju #6): `request_id` yoki yangi UUID. */
  private dispatchBatchId(dto: DispatchNotificationDto): string {
    const raw = (dto as { request_id?: unknown }).request_id;
    const requestId = typeof raw === 'string' ? raw.trim() : '';
    // activity_logs.entity_id — VARCHAR(100).
    return requestId && requestId.length <= 100 ? requestId : randomUUID();
  }

  /**
   * `internal` — FAQAT kod ichidan (xHPdpj0W kampaniya partiyasi): tayyor
   * qabul qiluvchilar va tranzaksiya ilgaklari. RMQ controller uni bermaydi.
   */
  async dispatch(
    dto: DispatchNotificationDto,
    internal?: InternalDispatchOptions,
  ) {
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

      // (7Ec56EIw #2 a/b) Katalog sukuti yoki chaqiruvchi so'ragani ∩
      // katalogda ruxsat etilgan kanallar — ortiqcha kanal qo'shilmaydi.
      const channels = requestedChannels(dto.type, defaults.channels);

      this.assertRecipientIds(dto);
      const recipients: ResolvedRecipient[] = internal?.recipients
        ? internal.recipients.map((recipient) => ({
            id: String(recipient.id),
            role: recipient.role ?? null,
            via: 'explicit' as const,
          }))
        : await this.resolveRecipients(dto);
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

      // (mP1WGG1W / 7Ec56EIw) Sozlamalar va kanal imkoniyati — BULK (sikl
      // ichida so'rov yo'q). Hamma filtrlansa — 400 emas, skipped_by_preference.
      const plan = await this.planChannels(dto, recipients);
      const targets = recipients.filter((r) => !plan.skipped.has(r.id));
      // (7Ec56EIw #5) CRITICAL: N daqiqadan keyin o'qilmagan bo'lsa SMS.
      const escalationDueAt =
        this.escalation?.dueAt(dto.priority, channels) ?? null;
      const deliveryFor: DeliveryFor = escalationDueAt
        ? (id) => ({
            ...plan.deliveryFor(id),
            escalation: 'scheduled',
            escalation_due_at: escalationDueAt.toISOString(),
          })
        : plan.deliveryFor;

      // 1) Persist one inbox row per recipient (the in_app channel & system of record).
      //    Push is only QUEUED here (outbox) — in the same transaction as the rows,
      //    so a rolled-back dispatch never sends a push. Delivery is async.
      //    Faqat `delivery.push = queued` qatorlar navbatga (obunasi yo'q /
      //    VAPID yo'q / o'chirilgan — outbox hodisasi yaratilmaydi).
      //    (xHPdpj0W) Kampaniya ilgaklari (before/afterPersist) qabul qiluvchi
      //    qolmasa ham ishlaydi — aks holda partiya da'vo qilinmay, kampaniya
      //    navbati to'xtab qolardi.
      let pushQueued = 0;
      const rows =
        !targets.length && !internal
          ? []
          : await this.repo.manager.transaction(async (manager) => {
              await internal?.beforePersist?.(manager);
              const persisted = targets.length
                ? await this.persistRows(
                    manager,
                    dto,
                    targets,
                    channels,
                    deliveryFor,
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
              // SMS: navbatga ham shu tranzaksiyada; holat har qatorning delivery.sms ida.
              if (wantsSms && persisted.length) {
                smsResult = await this.queueSms(persisted, manager);
              }
              if (escalationDueAt && persisted.length && this.escalation) {
                await this.escalation.schedule(
                  manager,
                  persisted.map((row) => row.id),
                  escalationDueAt,
                );
              }
              await internal?.afterPersist?.(manager, persisted);
              return persisted;
            });

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
      if (channels.includes(NotificationChannel.TELEGRAM)) {
        const relayed = await this.relayTelegram(dto);
        telegram = relayed.result;
        telegramOutcome = relayed.outcome;
      }

      // 4) Kanal natijalari dispatch oxirida BITTA bulk UPDATE bilan (sikl
      //    ichida save YO'Q). Email — provayder yo'q: `no_provider` qatorga
      //    INSERT paytida yozilgan (persistRows).
      await this.recordDelivery(rows, realtime, telegramOutcome);

      // Audit: ONE row per dispatch operation (never one per recipient).
      const actor = (dto as { requester?: { id?: string; roles?: string[] } })
        .requester;
      /**
       * entity_id — HAQIQIY dispatch partiyasi ID si (f2Ud5tju #6), qattiq
       * `'dispatch'` satri emas (jurnalda hammasi "Notification #dispatch"
       * bo'lib, bir-biridan ajratib bo'lmasdi). Manba: chaqiruvchining
       * `request_id` si (`rmqSend` har chaqiruvga beradi, timeout qayta
       * urinishida o'zgarmaydi — bir partiya bitta ID), bo'lmasa yangi UUID.
       * Shu ID javobda `dispatch_id` bo'lib qaytadi, yaratilgan qatorlar esa
       * `notification_ids` (birinchi 20 ta) orqali bog'lanadi.
       */
      const dispatchId = this.dispatchBatchId(dto);
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
      );
      const message =
        !rows.length && plan.skipped.size
          ? 'Skipped by recipient preferences — nothing dispatched'
          : summary.message;

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
          // (mP1WGG1W) Sozlama bilan tushib qolganlar — 400 emas, hisob.
          skipped_by_preference: plan.skipped.size,
        },
        201,
        message,
      );
    } catch (error) {
      this.toRpcError(error);
    }
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
    const result = await this.smsDispatch.queueForNotifications(
      eligible,
      manager,
    );
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
  ): Promise<Notification[]> {
    const repo = manager.getRepository(Notification);
    const base = {
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
        if (!rowIdByRecipient.has(key)) rowIdByRecipient.set(key, row.id);
      }

      // Bir xil rol + bir xil boshlang'ich `delivery` — BITTA UPDATE.
      const groups = new Map<
        string,
        {
          role: string | null;
          delivery: Record<string, string>;
          ids: string[];
        }
      >();
      for (const recipient of recipients) {
        const rowId = rowIdByRecipient.get(recipient.id);
        if (!rowId) continue;
        const delivery = deliveryFor(recipient.id);
        const key = JSON.stringify([recipient.role, delivery]);
        const group = groups.get(key) ?? {
          role: recipient.role,
          delivery,
          ids: [],
        };
        group.ids.push(rowId);
        groups.set(key, group);
      }
      for (const { role, delivery, ids } of groups.values()) {
        // jsonb ustunlari (`data`, `delivery`) TypeORM deep-partial turiga sig'maydi.
        await repo.update({ id: In(ids) }, {
          ...base,
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
   * ⚠️ Bot tokeni payload'dan OLINMAYDI — faqat DB (telegram_markets) yoki
   * env (TELEGRAM_BOT_TOKEN). Matn `parse_mode: HTML`: chaqiruvchi tayyor
   * `telegram.text` bermasa sarlavha/tana HTML-escape qilinadi (`<`/`&`
   * bo'lsa Telegram butun xabarni rad etardi).
   */
  private async relayTelegram(
    dto: DispatchNotificationDto,
  ): Promise<{ result: unknown; outcome: TelegramOutcome }> {
    const target = dto.telegram;
    if (!target?.market_id && !target?.group_id) {
      return {
        result: null,
        outcome: {
          telegram: NotificationDeliveryStatus.NOT_ELIGIBLE,
          telegram_error: 'telegram_target_missing',
        },
      };
    }
    const message =
      typeof target.text === 'string' && target.text.trim()
        ? target.text
        : dto.body
          ? `${escapeTelegramHtml(dto.title)}\n\n${escapeTelegramHtml(dto.body)}`
          : escapeTelegramHtml(dto.title);
    try {
      const res = (await this.telegramService.sendNotification({
        market_id: target.market_id,
        group_id: target.group_id,
        group_type: target.group_type,
        message: message.slice(0, 4096),
        parse_mode: 'HTML',
      })) as {
        data?: {
          success?: number;
          failed?: number;
          results?: Array<{ ok?: boolean; error?: string }>;
        };
      } | null;
      const data = res?.data ?? {};
      const success = Number(data.success ?? 0);
      const failed = Number(data.failed ?? 0);
      const firstError =
        data.results?.find((item) => !item.ok)?.error ?? 'telegram_failed';
      const outcome: TelegramOutcome =
        success > 0 && failed === 0
          ? {
              telegram: NotificationDeliveryStatus.SENT,
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
  ) {
    const byChannel: Record<string, number> = { in_app: rows };
    const noProvider: string[] = [];
    for (const channel of channels) {
      if (channel === NotificationChannel.REALTIME) {
        byChannel.realtime = realtime?.emitted ?? 0;
      } else if (channel === NotificationChannel.TELEGRAM) {
        byChannel.telegram = Number(telegram?.telegram_sent ?? 0);
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
    const delivered = external.filter((channel) => byChannel[channel] > 0);
    const message =
      delivered.length === external.length
        ? 'Notification dispatched'
        : delivered.length
          ? 'Partially dispatched'
          : 'Saved to inbox only — no external channel delivered';
    return { by_channel: byChannel, no_provider: noProvider, message };
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
