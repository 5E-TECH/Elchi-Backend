import type { EntityManager } from 'typeorm';
import type { Notification } from '../entities/notification.entity';

/**
 * (xHPdpj0W) `NotificationInboxService.dispatch` ning ICHKI ikkinchi
 * parametri — faqat kod ichidan (kampaniya partiyasi). RMQ payload'idan
 * KELMAYDI: controller `dispatch(data)` ni bitta argument bilan chaqiradi,
 * shuning uchun tashqi chaqiruvchi bu ilgaklarni bera olmaydi.
 */
export interface InternalDispatchOptions {
  /**
   * Qabul qiluvchilar allaqachon yig'ilgan (kampaniya partiyasi, identity
   * keyset sahifasi). Berilsa `resolveRecipients` chaqirilmaydi. Realtime —
   * har biriga `user_id` emit (rol xonasiga emas: segmentlangan auditoriyada
   * butun rol xonasi signal olmasin).
   */
  recipients?: Array<{ id: string; role: string | null }>;
  /**
   * Inbox tranzaksiyasi ichida, qatorlardan OLDIN (partiya da'vosi — shartli
   * UPDATE qator qulfini oladi). `DispatchAbortedError` — hech narsa
   * yozilmaydi va xato o'zgarmasdan qaytadi.
   */
  beforePersist?: (manager: EntityManager) => Promise<void>;
  /**
   * Shu tranzaksiya ichida, qatorlardan KEYIN (hisoblagich + keyingi partiya
   * outbox'ga). Xato — qatorlar ham rollback bo'ladi.
   */
  afterPersist?: (
    manager: EntityManager,
    rows: Notification[],
  ) => Promise<void>;
  /**
   * (9D1Gl9MS) Kampaniya partiyasining SMS kanali REKLAMA (`promo`) sifatida:
   * rozilik darvozasi (roziligi yo'q — `sms: skipped`, `sms_reason:
   * no_consent`), 18:00–09:00 taqiq, opt-out havolasi, kunlik kvota. Oddiy
   * dispatch (tizim hodisasi) — avvalgidek `transactional`.
   */
  smsMessageClass?: 'promo';
}

/**
 * Dispatch ataylab to'xtatildi (masalan partiya allaqachon bajarilgan yoki
 * kampaniya bekor qilingan) — RpcException'ga O'RALMAYDI.
 */
export class DispatchAbortedError extends Error {
  constructor(readonly reason: string) {
    super(`dispatch aborted: ${reason}`);
    this.name = 'DispatchAbortedError';
  }
}
