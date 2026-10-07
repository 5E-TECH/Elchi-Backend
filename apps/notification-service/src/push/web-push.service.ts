import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as webpush from 'web-push';
import { PushSubscription } from '../entities/push-subscription.entity';

/** Brauzerga boradigan push matni (sw.js `push` hodisasi shuni o'qiydi). */
export interface PushPayload {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  type: string;
  priority: string;
  /** Bir xil teg — telefonda bitta bildirishnoma yangilanadi, ustma-ust tushmaydi. */
  tag: string;
}

export interface PushSendResult {
  /** Muvaffaqiyatli yetkazilgan obunalar soni. */
  sent: number;
  /** Provayder rad etgan (o'lik bo'lmagan) obunalar soni. */
  failed: number;
  /** 404/410 — o'chirib tashlangan o'lik obunalar soni. */
  gone: number;
  /** Birinchi xato matni (delivery.push_error uchun). */
  error: string | null;
}

/** Bir partiyadagi parallel yuborishlar soni. */
const SEND_BATCH_SIZE = 100;
/** Partiyalar orasidagi pauza — provayder rate-limitiga hurmat. */
const BATCH_PAUSE_MS = 50;
/** Bitta endpointga so'rov chegarasi — outbox javob muddatidan ancha kam. */
const SEND_TIMEOUT_MS = 5_000;
/** Qurilma oflayn bo'lsa provayder xabarni shuncha saqlaydi (sekund). */
const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** Push matni ~4 KB chegarasidan oshmasin. */
const MAX_BODY_LENGTH = 1_000;
const MAX_ERROR_LENGTH = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (error: unknown): string => {
  const err = error as { statusCode?: number; body?: string; message?: string };
  const parts = [
    err?.statusCode ? `HTTP ${err.statusCode}` : null,
    err?.body || err?.message || 'unknown',
  ].filter(Boolean);
  return parts.join(': ').slice(0, MAX_ERROR_LENGTH);
};

/**
 * `web-push` kutubxonasi ustidagi yupqa qatlam.
 *
 * VAPID kalitlari bo'lmasa servis baribir ishlaydi — push o'chiq bo'ladi va
 * startda aniq WARN yoziladi. PRIVATE kalit faqat shu yerda o'qiladi va hech
 * qachon javobga chiqmaydi (`publicKey` faqat public qismni beradi).
 */
@Injectable()
export class WebPushService implements OnModuleInit {
  private readonly logger = new Logger(WebPushService.name);
  private vapidPublicKey: string | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(PushSubscription)
    private readonly subscriptions: Repository<PushSubscription>,
  ) {}

  onModuleInit(): void {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY')?.trim();
    const subject = this.config.get<string>('VAPID_SUBJECT')?.trim();

    if (!publicKey || !privateKey || !subject) {
      this.logger.warn(
        "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT berilmagan — web push O'CHIQ (obuna va yuborish ishlamaydi).",
      );
      return;
    }

    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.vapidPublicKey = publicKey;
      this.logger.log('Web push yoqildi (VAPID kalitlari yuklandi).');
    } catch (error) {
      this.logger.error(
        `VAPID kalitlari yaroqsiz — web push O'CHIQ: ${errorMessage(error)}`,
      );
    }
  }

  get enabled(): boolean {
    return this.vapidPublicKey !== null;
  }

  /** Faqat PUBLIC kalit — frontend `applicationServerKey` uchun. */
  get publicKey(): string | null {
    return this.vapidPublicKey;
  }

  /** Foydalanuvchining barcha obunalariga yuboradi. */
  async sendToUser(
    userId: string,
    payload: PushPayload,
  ): Promise<PushSendResult> {
    const subs = await this.subscriptions.find({ where: { user_id: userId } });
    return this.sendToSubscriptions(subs, payload);
  }

  /**
   * Obunalarga PARTIYALAB parallel yuboradi (`Promise.allSettled`, 100 tadan).
   *
   * ⚠️ notification-inbox.service.ts dagi `pushRealtime` ketma-ket loop
   * naqshini NUSXALAMANG — u har qabul qiluvchini alohida kutadi.
   *
   * Natija DB'ga yoziladi: muvaffaqiyat → `last_used_at`; 404/410 → qator
   * darhol o'chiriladi; boshqa xato → `last_error`, qator qoladi.
   */
  async sendToSubscriptions(
    subs: PushSubscription[],
    payload: PushPayload,
  ): Promise<PushSendResult> {
    const result: PushSendResult = { sent: 0, failed: 0, gone: 0, error: null };
    if (!this.enabled || !subs.length) return result;

    const body = JSON.stringify({
      ...payload,
      body: payload.body ? payload.body.slice(0, MAX_BODY_LENGTH) : null,
    });
    const urgency: webpush.Urgency =
      payload.priority === 'high' || payload.priority === 'critical'
        ? 'high'
        : 'normal';

    const okIds: string[] = [];
    const goneIds: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];

    for (let start = 0; start < subs.length; start += SEND_BATCH_SIZE) {
      if (start > 0) await sleep(BATCH_PAUSE_MS);
      const batch = subs.slice(start, start + SEND_BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map((sub) =>
          webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            body,
            { TTL: PUSH_TTL_SECONDS, urgency, timeout: SEND_TIMEOUT_MS },
          ),
        ),
      );
      settled.forEach((outcome, index) => {
        const sub = batch[index];
        if (outcome.status === 'fulfilled') {
          okIds.push(sub.id);
          return;
        }
        const statusCode = (outcome.reason as { statusCode?: number })
          ?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          goneIds.push(sub.id);
          return;
        }
        failures.push({ id: sub.id, error: errorMessage(outcome.reason) });
      });
    }

    if (okIds.length) {
      await this.subscriptions.update(
        { id: In(okIds) },
        { last_used_at: new Date(), last_error: null },
      );
    }
    if (goneIds.length) {
      await this.subscriptions.delete({ id: In(goneIds) });
    }
    for (const failure of failures) {
      await this.subscriptions.update(
        { id: failure.id },
        { last_error: failure.error },
      );
    }

    result.sent = okIds.length;
    result.gone = goneIds.length;
    result.failed = failures.length;
    result.error =
      failures[0]?.error ?? (goneIds.length ? 'subscription_gone' : null);
    return result;
  }
}
