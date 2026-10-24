import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

@Entity({ name: 'products' })
// As75bkGo: unique faqat FAOL qatorlar uchun — o'chirilgan mahsulot nomi
// qayta ishlatiladi (migratsiya 1716000000087).
@Index('IDX_products_name_user_id', ['name', 'user_id'], {
  unique: true,
  where: '"is_deleted" = false',
})
// Aws1oApe: registrga befarq unique — `(lower(btrim(name)), user_id)
// WHERE is_deleted = false` (ifoda indeksi, migratsiya 1716000000117).
// TypeORM ifoda indeksini o'zi qura olmaydi — faqat qayd uchun.
@Index('IDX_products_lower_name_user_id', { synchronize: false })
@Index('IDX_PRODUCT_USER_ID', ['user_id'])
@Index('IDX_PRODUCT_DELETED', ['isDeleted'])
// hY7uacJu: zavod shtrix kodi market ichida yagona — faqat FAOL qatorlar
// (o'chirilgan mahsulot kodi qayta ishlatiladi). Indekslar migratsiya
// 1716000000141 da yaratiladi; TypeORM `synchronize` DatabaseModule
// darajasida o'chiq (`libs/common/src/database/database.module.ts`) —
// dekoratorlar sxemani qayd etish (va kelajakdagi migration:generate) uchun.
@Index('UQ_products_barcode_user_id', ['barcode', 'user_id'], {
  unique: true,
  where: '"is_deleted" = false AND "barcode" IS NOT NULL',
})
@Index('UQ_products_sku_code', ['sku_code'], { unique: true })
export class Product extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({ type: 'varchar', nullable: true })
  image_url!: string | null;

  /**
   * zRqDRLAZ: mahsulotning ma'lumotnoma narxi (so'm). Ixtiyoriy — berilmagan
   * mahsulotda `null` (frontend bo'sh "so'm" chizmaydi). Buyurtma summasiga
   * avtomatik yozilmaydi: forma faqat TAKLIF qiladi, operator o'zgartiradi
   * (migratsiya 1716000000116).
   */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  price!: number | null;

  /**
   * MH-3 (9fHyFp3y): og'irlik, kg (ko'pi bilan 3 kasr). Yetkazish narxi
   * dvigateli (DAqXPeSy) o'qiydi. HTTP orqali yangi mahsulotda majburiy
   * (MH-S1), lekin ustun NULLABLE — eski va hamkor avtomatik yaratgan
   * mahsulot o'lchovsiz bo'lishi mumkin (migratsiya 1716000000141).
   */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  weight_kg!: number | null;

  /**
   * MH-3: o'lchamlar, sm (butun son). Uchalasi birga — yoki hammasi bor,
   * yoki hammasi NULL (`CHK_products_dimensions_all_or_none`).
   */
  @Column({ type: 'int', nullable: true })
  length_cm!: number | null;

  @Column({ type: 'int', nullable: true })
  width_cm!: number | null;

  @Column({ type: 'int', nullable: true })
  height_cm!: number | null;

  /**
   * MH-3: «hajmga qarab hisoblash» — sukut bo'yicha YONIQ. O'chirilsa narx
   * faqat haqiqiy og'irlikdan hisoblanadi (hajmli vazn e'tiborga olinmaydi).
   */
  @Column({ type: 'boolean', default: true })
  volumetric_enabled!: boolean;

  /**
   * hY7uacJu: zavod shtrix kodi (EAN/UPC/GTIN yoki QR matni) — ixtiyoriy,
   * market ichida yagona. Normalizatsiya: `@app/common`
   * `normalizeProductBarcode` — GTIN KANONIK shaklda (`canonicalGtin`:
   * UPC-A `036000291452` → `0036000291452`; UPC-E `04963406` —
   * kengaytirilgan UPC-A sifatida `0049000006346`).
   */
  @Column({ type: 'varchar', length: 512, nullable: true })
  barcode!: string | null;

  /**
   * hY7uacJu: Elchi kodi `ELC-P-000123` — DB'da STORED generated ustun
   * (`formatProductSkuCode` bilan AYNI ifoda). Ilova YOZMAYDI
   * (`insert/update: false`); `save()` dan keyin INSERT RETURNING bilan
   * darhol to'ladi.
   */
  @Column({
    type: 'varchar',
    length: 32,
    insert: false,
    update: false,
    generatedType: 'STORED',
    asExpression: `'ELC-P-' || lpad("id"::text, GREATEST(6, length("id"::text)), '0')`,
  })
  sku_code!: string;
}
