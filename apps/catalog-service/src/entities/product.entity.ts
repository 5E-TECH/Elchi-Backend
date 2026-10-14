import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

@Entity({ name: 'products' })
// As75bkGo: unique faqat FAOL qatorlar uchun — o'chirilgan mahsulot nomi
// qayta ishlatiladi (migratsiya 1716000000087).
@Index('IDX_products_name_user_id', ['name', 'user_id'], {
  unique: true,
  where: '"is_deleted" = false',
})
@Index('IDX_PRODUCT_USER_ID', ['user_id'])
@Index('IDX_PRODUCT_DELETED', ['isDeleted'])
export class Product extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({ type: 'varchar', nullable: true })
  image_url!: string | null;
}
