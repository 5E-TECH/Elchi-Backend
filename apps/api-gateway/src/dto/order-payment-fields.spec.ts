import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  UpdateOrderRequestDto,
  UpdateOrderByIdRequestDto,
} from './order.swagger.dto';

/**
 * ONLAYN TO'LOV MAYDONLARI QO'LDA O'ZGARTIRILMASIN (7-bosqich).
 *
 * ⚠️ NEGA BU TEST KERAK. `paid_online_amount` va `payment_status` FAQAT
 * imzolangan to'lov webhooki orqali yozilishi kerak. Ular buyurtma
 * yangilash DTO'siga qo'shilsa (masalan "qulaylik uchun"), ikki teshik
 * ochiladi:
 *
 *  1. Operator buyurtmani "to'langan" deb belgilab, kuryerni naqd
 *     yig'ishdan to'sib qo'yadi — pul esa hech qachon kelmagan.
 *  2. Teskarisi: `payment_status` ni tozalab, onlayn to'langan posilkadan
 *     yana naqd yig'iladi (mijoz ikki marta to'laydi).
 *
 * Gateway'da `whitelist: true, forbidNonWhitelisted: true` (`main.ts`),
 * ya'ni DTO'da e'lon qilinmagan maydon 400 beradi. Bu test shu himoyani
 * QULFLAYDI — DTO o'zgarsa test yiqiladi.
 */
describe("Buyurtma yangilash DTO'si to'lov maydonlarini QABUL QILMAYDI", () => {
  const PAYMENT_FIELDS = ['paid_online_amount', 'payment_status'];

  const forbidden = async (cls: new () => object, payload: object) => {
    const dto = plainToInstance(cls, payload);
    /**
     * `whitelistValidation` — `forbidNonWhitelisted` ning validator
     * darajasidagi ekvivalenti: e'lon qilinmagan maydon xato beradi.
     */
    return validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  };

  it.each(PAYMENT_FIELDS)(
    'UpdateOrderRequestDto `%s` ni rad etadi',
    async (field) => {
      const errors = await forbidden(UpdateOrderRequestDto, {
        [field]: field === 'payment_status' ? 'paid' : 250000,
      });
      expect(errors.map((e) => e.property)).toContain(field);
    },
  );

  it.each(PAYMENT_FIELDS)(
    'UpdateOrderByIdRequestDto `%s` ni rad etadi',
    async (field) => {
      const errors = await forbidden(UpdateOrderByIdRequestDto, {
        [field]: field === 'payment_status' ? 'paid' : 250000,
      });
      expect(errors.map((e) => e.property)).toContain(field);
    },
  );

  it('⭐ e`lon qilingan maydon esa o`tadi (test soxta emas)', async () => {
    /**
     * Yuqoridagi testlar "hamma narsa rad etiladi" degani bo'lmasligi
     * kerak — aks holda ular hech narsani isbotlamasdi.
     */
    const errors = await forbidden(UpdateOrderRequestDto, { comment: 'ok' });
    expect(errors.map((e) => e.property)).not.toContain('comment');
  });
});
