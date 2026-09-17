/// <reference types="jest" />
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreatePartnerShipmentRequestDto } from './dto/partner-shipment.swagger.dto';

/**
 * GATEWAY DTO VA HAMKOR YUBORADIGAN TANA — AJRALIB KETMASLIGI KERAK.
 *
 * ⚠️ NIMA BUZILGAN EDI (real sinovda topildi). Gateway
 * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` bilan
 * ishlaydi: DTO da E'LON QILINMAGAN maydon 400 bilan RAD ETILADI.
 *
 * Qop (batch) maydonlarini ichki servis tipiga qo'shib, DTO ga qo'shishni
 * UNUTGANIM uchun butun jo'natish yo'li yiqildi:
 *
 *   400: property batch_ref should not exist.
 *        property batch_label_token should not exist
 *
 * Eng yomoni: hech bir unit test buni tutmadi, chunki testlar servisni
 * TO'G'RIDAN-TO'G'RI chaqiradi va gateway validatsiyasidan o'tmaydi. Xato
 * faqat HAQIQIY so'rovda ko'rindi.
 *
 * Bu spec shu bo'shliqni yopadi: PCS (BeePost) yuboradigan TO'LIQ tana
 * DTO dan o'tishi tekshiriladi. Yangi maydon qo'shilib DTO ga yozilmasa,
 * bu test yiqiladi.
 */

/**
 * PCS `createShipmentForOrder` yuboradigan tana — maydonlar ro'yxati
 * `post_control_system/server/src/api/elchi-cargo/elchi-shipment.service.ts`
 * dan olingan.
 */
const pcsBody = () => ({
  external_order_id: 'a1b2c3d4-0000-0000-0000-000000000001',
  elchi_market_id: '121',
  customer: { name: 'Aliyev Vali', phone: '+998901234567' },
  address: 'Chilonzor 12',
  region_id: '3',
  district_id: '173',
  where_deliver: 'center',
  items: [
    {
      name: 'Telefon',
      quantity: 1,
      external_product_id: 'p-1',
    },
  ],
  cod_amount: 250000,
  subtotal: 250000,
  // Jismoniy POSILKA yorlig'i (bizning QR).
  label_token: 'a7e4677ba58721124a4261b7',
  // QOP ma'lumoti.
  batch_ref: 'post-77',
  batch_label_token: '0a89cee1a2d2746e3a739541',
  batch_size: 12,
});

const errorsFor = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(CreatePartnerShipmentRequestDto, body, {
    enableImplicitConversion: false,
  });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map(
    (e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
  );
};

describe('⭐ CreatePartnerShipmentRequestDto — PCS tanasi to`liq o`tadi', () => {
  it('⭐ PCS yuboradigan TO`LIQ tana xatosiz o`tadi', async () => {
    expect(await errorsFor(pcsBody())).toEqual([]);
  });

  it('⭐ QOP maydonlari DTO da E`LON QILINGAN (forbidNonWhitelisted)', async () => {
    /**
     * Aynan shu tekshiruv yo'q bo'lgani uchun xato jonli so'rovgacha
     * yetib bordi. `forbidNonWhitelisted` e'lon qilinmagan maydonni
     * "should not exist" bilan rad etadi.
     */
    for (const field of ['batch_ref', 'batch_label_token', 'batch_size']) {
      const errors = await errorsFor(pcsBody());
      expect(errors.join(' ')).not.toContain(field);
    }
  });

  it('qop maydonlari IXTIYORIY — ularsiz ham o`tadi', async () => {
    const body = pcsBody();
    delete (body as Record<string, unknown>).batch_ref;
    delete (body as Record<string, unknown>).batch_label_token;
    delete (body as Record<string, unknown>).batch_size;
    expect(await errorsFor(body)).toEqual([]);
  });

  it('⭐ PCS pochta tokeni `batch_label_token` naqshiga MOS', async () => {
    /**
     * PCS tokenlari 24 belgili hex (`a7e4677ba58721124a4261b7`). Naqsh
     * `[A-Za-z0-9_-]{8,128}` — mos. Naqsh torayib qolsa bu test yiqiladi
     * va jo'natish jimgina buzilmaydi.
     */
    const body = {
      ...pcsBody(),
      batch_label_token: 'a7e4677ba58721124a4261b7',
    };
    expect(await errorsFor(body)).toEqual([]);
  });

  it('noto`g`ri formatdagi qop tokeni RAD ETILADI', async () => {
    const body = {
      ...pcsBody(),
      batch_label_token: 'juda qisqa va bo`sh joyli',
    };
    expect((await errorsFor(body)).join(' ')).toMatch(/batch_label_token/);
  });

  it('e`lon qilinmagan BEGONA maydon rad etiladi (darvoza ishlayapti)', async () => {
    /**
     * Bu testning maqsadi — `forbidNonWhitelisted` haqiqatan ishlayotganini
     * tasdiqlash. Busiz yuqoridagi testlar hech narsani isbotlamasdi.
     */
    const body = { ...pcsBody(), butunlay_begona_maydon: 1 };
    expect((await errorsFor(body)).join(' ')).toMatch(/begona_maydon/);
  });
});
