import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Notification } from '../entities/notification.entity';

/** Kalit uzunligi — `notification_dispatch_keys.key` VARCHAR(220). */
const KEY_MAX = 220;

/**
 * (rzGKtE9N TC5) `notification.dispatch` ning qayta yetkazilishidan himoya.
 *
 * Outbox (`order.*`, `finance.*` hodisalari) har hodisaga barqaror
 * `request_id` beradi, qayta urinishda u o'zgarmaydi. Ilgari takror dispatch
 * group_key bo'yicha o'sha inbox qatorini YANGILAB, `delivery.telegram` ni
 * yana `queued` qilardi — Telegram xabari IKKINCHI marta ketardi. Endi
 * `<type>:<request_id>` kaliti dispatch tranzaksiyasining ICHIDA egallanadi:
 * band bo'lsa — hech narsa yozilmaydi va yuborilmaydi; tranzaksiya
 * yiqilsa kalit ham qaytadi (haqiqiy qayta urinish yo'qolmaydi).
 * Eski kalitlar `BotMaintenanceService.prune` da (7 kun).
 */
@Injectable()
export class DispatchDedupService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  static key(type: string, requestId: string): string {
    return `${type.trim()}:${requestId}`.slice(0, KEY_MAX);
  }

  /**
   * Arzon oldindan tekshiruv (qulfsiz): kalit allaqachon bormi. Yakuniy
   * kafolat — tranzaksiya ichidagi `claim`.
   */
  async seen(key: string): Promise<boolean> {
    const rows: unknown = await this.notifications.query(
      `SELECT 1 FROM "notification_schema"."notification_dispatch_keys" WHERE "key" = $1`,
      [key.slice(0, KEY_MAX)],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  /** `true` — birinchi marta (davom etiladi), `false` — takror. */
  async claim(manager: EntityManager, key: string): Promise<boolean> {
    const rows: unknown = await manager.query(
      `INSERT INTO "notification_schema"."notification_dispatch_keys" ("key")
       VALUES ($1)
       ON CONFLICT ("key") DO NOTHING
       RETURNING "key"`,
      [key.slice(0, KEY_MAX)],
    );
    return Array.isArray(rows) && rows.length > 0;
  }
}
