import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, MoreThanOrEqual, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  ActivityLogService,
  NOTIFICATION_SMS_DELIVERY_STATUS_PATTERN,
  NOTIFICATION_SMS_TEMP_PASSWORD_PATTERN,
  PASSWORD_SMS_COOLDOWN,
  PASSWORD_SMS_DAILY_LIMIT,
  PASSWORD_SMS_RESEND_COOLDOWN_SECONDS,
  PASSWORD_SMS_RESEND_DAILY_LIMIT,
  PASSWORD_SMS_STATUSES,
  type PasswordSmsStatus,
  endOfTashkentDay,
  passwordSmsFailureMessage,
  rmqSend,
  startOfTashkentDay,
} from '@app/common';
import type { User } from '../entities/user.entity';
import {
  PasswordSmsReason,
  UserPasswordSms,
} from '../entities/user-password-sms.entity';

/** notification `notification.sms.send_temp_password` / `delivery_status` javobi. */
interface NotificationSmsState {
  client_message_id?: string;
  status?: string;
  failure_reason?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
}

/** API javobidagi SMS holati (`password_sms`). Parol YO'Q. */
export interface PasswordSmsView {
  status: PasswordSmsStatus;
  /** Mashina kodi: `sms_disabled`, `invalid_phone`, `provider_rejected` … */
  failure_reason: string | null;
  /** O'zbekcha sabab (FE ko'rsatadi). */
  failure_message: string | null;
  requested_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  /** Shu vaqtdan keyin «Qayta yuborish» mumkin (60 s). */
  resend_available_at: string;
  /** Bugun (Toshkent kuni) yana necha marta qayta yuborish mumkin. */
  resends_left_today: number;
}

/** SMS navbatga qo'yish — gateway 8 s byudjetidan ancha kichik, qayta urinishsiz. */
const SEND_TIMEOUT_MS = 3000;
const STATUS_TIMEOUT_MS = 3000;
const LOCK_PREFIX = 'identity.temp_password:';

const isStatus = (value: unknown): value is PasswordSmsStatus =>
  (PASSWORD_SMS_STATUSES as readonly unknown[]).includes(value);

const iso = (value: unknown): string | null => {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

/**
 * (aidsxJ2H) Vaqtinchalik parol SMS'i: navbatga berish (notification
 * `sms_outbox` orqali — boshqa yo'l yo'q), qayta yuborish chegarasi
 * (60 s / kuniga 5) va yetkazish holati.
 *
 * PAROL: faqat `send()` argumentida, RMQ xabarida (qayta urinishsiz) — DB,
 * log, faoliyat jurnali, javobga TUSHMAYDI. SMS xatosi foydalanuvchi
 * yaratish / parol almashtirishni BUZMAYDI — holat `failed` + sabab.
 */
@Injectable()
export class TempPasswordService {
  private readonly logger = new Logger(TempPasswordService.name);

  constructor(
    @InjectRepository(UserPasswordSms)
    private readonly sends: Repository<UserPasswordSms>,
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * Qayta yuborish chegarasi (chaqiruvchi tranzaksiyasi ichida, foydalanuvchi
   * bo'yicha advisory qulf ostida — ikki parallel bosish ikkalasi o'tmaydi)
   * va yangi jurnal qatorini band qilish. 429 — `PASSWORD_SMS_COOLDOWN` /
   * `PASSWORD_SMS_DAILY_LIMIT` (`retry_after_seconds`).
   */
  async reserveResend(
    manager: EntityManager,
    userId: string,
    requestedBy: string | null,
    now = new Date(),
  ): Promise<UserPasswordSms> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${LOCK_PREFIX}${userId}`,
    ]);
    const repo = manager.getRepository(UserPasswordSms);
    const [last] = await repo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      take: 1,
    });
    const cooldownMs = PASSWORD_SMS_RESEND_COOLDOWN_SECONDS * 1000;
    if (last && now.getTime() - last.created_at.getTime() < cooldownMs) {
      const wait = Math.ceil(
        (cooldownMs - (now.getTime() - last.created_at.getTime())) / 1000,
      );
      throw new RpcException({
        statusCode: 429,
        message: `SMS'ni qayta yuborish ${wait} soniyadan keyin mumkin`,
        data: null,
        code: PASSWORD_SMS_COOLDOWN,
        retry_after_seconds: wait,
      });
    }
    const today = await repo.count({
      where: {
        user_id: userId,
        reason: 'resend',
        created_at: MoreThanOrEqual(startOfTashkentDay(now)),
      },
    });
    if (today >= PASSWORD_SMS_RESEND_DAILY_LIMIT) {
      const wait = Math.max(
        1,
        Math.ceil((endOfTashkentDay(now).getTime() + 1 - now.getTime()) / 1000),
      );
      throw new RpcException({
        statusCode: 429,
        message: `Bugun SMS ${PASSWORD_SMS_RESEND_DAILY_LIMIT} marta qayta yuborildi — ertaga urinib ko'ring`,
        data: null,
        code: PASSWORD_SMS_DAILY_LIMIT,
        retry_after_seconds: wait,
      });
    }
    return repo.save(
      repo.create({
        user_id: userId,
        client_message_id: `tmppw-${randomUUID()}`,
        reason: 'resend',
        requested_by: requestedBy,
        status: 'pending',
        failure_reason: null,
      }),
    );
  }

  /**
   * Parolni SMS navbatiga beradi va holatni qaytaradi. `row` berilmasa
   * (yaratish) yangi jurnal qatori yoziladi. HECH QACHON xato tashlamaydi.
   */
  async send(
    user: Pick<User, 'id' | 'phone_number' | 'language'>,
    password: string,
    input: {
      reason: PasswordSmsReason;
      requestedBy: string | null;
      row?: UserPasswordSms;
    },
  ): Promise<PasswordSmsView> {
    let row = input.row ?? null;
    try {
      row ??= await this.sends.save(
        this.sends.create({
          user_id: String(user.id),
          client_message_id: `tmppw-${randomUUID()}`,
          reason: input.reason,
          requested_by: input.requestedBy,
          status: 'pending',
          failure_reason: null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `Parol SMS jurnali yozilmadi (user ${user.id}): ${(error as Error)?.message ?? 'unknown'}`,
      );
      return this.view(
        null,
        { status: 'failed', failure_reason: 'internal_error' },
        0,
      );
    }

    let state: NotificationSmsState;
    try {
      state = await rmqSend<NotificationSmsState>(
        this.notificationClient,
        { cmd: NOTIFICATION_SMS_TEMP_PASSWORD_PATTERN },
        {
          phone: user.phone_number,
          password,
          client_message_id: row.client_message_id,
          lang: user.language ?? 'uz',
        },
        // Qayta urinish YO'Q: har urinish — yana bir xabar (parol bilan).
        { timeoutMs: SEND_TIMEOUT_MS, retries: 0, attachRequestId: false },
      );
    } catch (error) {
      // Parol / payload logga TUSHMAYDI — faqat xato turi.
      this.logger.warn(
        `Parol SMS navbatga berilmadi (user ${user.id}): ${(error as Error)?.name ?? 'Error'}`,
      );
      state = { status: 'failed', failure_reason: 'notification_unavailable' };
    }
    const status: PasswordSmsStatus = isStatus(state?.status)
      ? state.status
      : 'failed';
    const failureReason =
      status === 'failed'
        ? String(state?.failure_reason ?? 'internal_error').slice(0, 64)
        : null;
    row.status = status;
    row.failure_reason = failureReason;
    await this.sends
      .update({ id: row.id }, { status, failure_reason: failureReason })
      .catch((error: unknown) =>
        this.logger.warn(
          `Parol SMS holati yozilmadi (user ${user.id}): ${(error as Error)?.message ?? 'unknown'}`,
        ),
      );
    await this.activityLog
      .log({
        entity_type: 'User',
        entity_id: String(user.id),
        action: 'auth.temp_password_sms',
        metadata: {
          reason: input.reason,
          sms_status: status,
          failure_reason: failureReason,
        },
      })
      .catch(() => undefined);
    return this.view(
      row,
      { status, failure_reason: failureReason },
      await this.resendsUsedToday(String(user.id)),
    );
  }

  /**
   * Oxirgi SMS holati (jonli — notification `sms_outbox` dan; javob bermasa
   * oxirgi ma'lum holat). SMS hech yuborilmagan bo'lsa — `null`.
   */
  async latest(userId: string): Promise<PasswordSmsView | null> {
    const [row] = await this.sends.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      take: 1,
    });
    if (!row) return null;
    let live: NotificationSmsState | null = null;
    try {
      const states = await rmqSend<NotificationSmsState[]>(
        this.notificationClient,
        { cmd: NOTIFICATION_SMS_DELIVERY_STATUS_PATTERN },
        { client_message_ids: [row.client_message_id] },
        { timeoutMs: STATUS_TIMEOUT_MS, retries: 1 },
      );
      live =
        (Array.isArray(states) ? states : []).find(
          (state) => state?.client_message_id === row.client_message_id,
        ) ?? null;
    } catch (error) {
      this.logger.warn(
        `Parol SMS holati o'qilmadi (user ${userId}): ${(error as Error)?.name ?? 'Error'}`,
      );
    }
    if (live && isStatus(live.status)) {
      const failureReason =
        live.status === 'failed'
          ? String(live.failure_reason ?? 'provider_rejected').slice(0, 64)
          : null;
      if (row.status !== live.status || row.failure_reason !== failureReason) {
        row.status = live.status;
        row.failure_reason = failureReason;
        await this.sends
          .update(
            { id: row.id },
            { status: live.status, failure_reason: failureReason },
          )
          .catch(() => undefined);
      }
    }
    return this.view(
      row,
      {
        status: row.status,
        failure_reason: row.failure_reason,
        sent_at: live?.sent_at ?? null,
        delivered_at: live?.delivered_at ?? null,
      },
      await this.resendsUsedToday(userId),
    );
  }

  private async resendsUsedToday(userId: string, now = new Date()) {
    return this.sends
      .count({
        where: {
          user_id: userId,
          reason: 'resend',
          created_at: MoreThanOrEqual(startOfTashkentDay(now)),
        },
      })
      .catch(() => 0);
  }

  private view(
    row: UserPasswordSms | null,
    state: NotificationSmsState & {
      status: PasswordSmsStatus;
      failure_reason: string | null;
    },
    resendsUsedToday: number,
  ): PasswordSmsView {
    const requestedAt = row?.created_at ?? new Date();
    return {
      status: state.status,
      failure_reason: state.failure_reason,
      failure_message: passwordSmsFailureMessage(state.failure_reason),
      requested_at: requestedAt.toISOString(),
      sent_at: iso(state.sent_at),
      delivered_at: iso(state.delivered_at),
      resend_available_at: new Date(
        requestedAt.getTime() + PASSWORD_SMS_RESEND_COOLDOWN_SECONDS * 1000,
      ).toISOString(),
      resends_left_today: Math.max(
        0,
        PASSWORD_SMS_RESEND_DAILY_LIMIT - resendsUsedToday,
      ),
    };
  }
}
