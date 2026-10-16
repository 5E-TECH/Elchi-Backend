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
}
