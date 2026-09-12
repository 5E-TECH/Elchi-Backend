import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * Tashqi hamkor (birinchi navbatda Elchi Marketplace) — Elchi Partner API'dan
 * foydalanuvchi tizim. Hamkor har so'rovda `X-Api-Key` yuboradi; kalit bu yerda
 * HASH ko'rinishida saqlanadi (parol kabi). Chiquvchi (outbound) status
 * webhook'lari `webhook_secret` bilan HMAC-SHA256 imzolanadi.
 *
 * Batafsil kontrakt: docs/PARTNER_API.md.
 */
@Entity({ name: 'partners' })
@Index('IDX_PARTNER_API_KEY_HASH', ['api_key_hash'], { unique: true })
@Index('IDX_PARTNER_ACTIVE', ['is_active'])
export class Partner extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  /** API kalitning hash'i (kalitning o'zi saqlanmaydi). Kirishda hash solishtiriladi. */
  @Column({ type: 'varchar', unique: true })
  api_key_hash!: string;

  /** Statuslarni qaytarish uchun hamkor webhook manzili (chiquvchi). */
  @Column({ type: 'varchar', nullable: true })
  webhook_url!: string | null;

  /** Chiquvchi webhook HMAC sekret. AES bilan shifrlangan holda saqlanadi. */
  @Column({ type: 'varchar', nullable: true })
  webhook_secret!: string | null;

  /** Rotatsiya oynasida qabul qilinadigan oldingi sekret. AES-shifrlangan. */
  @Column({ type: 'varchar', nullable: true })
  webhook_secret_previous!: string | null;

  /**
   * SANDBOX (sinov) manzili — har bir chiquvchi hodisaning NUSXASI shu yerga
   * ham yuboriladi.
   *
   * NEGA KERAK. Prodakshnga chiqqandan keyin `webhook_url` haqiqiy qabul
   * qiluvchiga qaratilgan bo'ladi va unga tegib bo'lmaydi. Integratsiyani
   * tekshirish uchun esa HAQIQIY hodisalar oqimini ko'rish kerak — sinov
   * buyurtmasi yaratmasdan.
   *
   * ⚠️ MUHIM: sandboxga yuborish "eng yaxshi harakat" (best-effort). Uning
   * xatosi asosiy yetkazishga TA'SIR QILMAYDI va qayta urinilmaydi —
   * sinov kanali tufayli haqiqiy hodisa `permanently_failed` bo'lib
   * qolishi mutlaqo qabul qilinmaydi.
   *
   * Yuqilgan yukda `sandbox: true` bayrog'i bo'ladi, ya'ni qabul qiluvchi
   * uni haqiqiy hodisadan ajrata oladi.
   */
  @Column({ type: 'varchar', nullable: true })
  sandbox_webhook_url!: string | null;

  /**
   * Sandbox uchun alohida sekret. Berilmasa ASOSIY sekret ishlatiladi —
   * ko'p holatda sinov muhiti ayni sekret bilan tekshiradi.
   */
  @Column({ type: 'varchar', nullable: true })
  sandbox_webhook_secret!: string | null;

  /** Ixtiyoriy IP allowlist (bo'sh/null = cheklovsiz). */
  @Column({ type: 'jsonb', nullable: true })
  ip_allowlist!: string[] | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;
}
