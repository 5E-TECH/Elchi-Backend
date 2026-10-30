/// <reference types="jest" />
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreatePartnerShipmentRequestDto,
  UpdatePartnerShipmentRequestDto,
} from './dto/partner-shipment.swagger.dto';

/**
 * 6tGZzupr — `ShipmentItemDto` o'lchov maydonlari. Gateway
 * `forbidNonWhitelisted` bilan ishlaydi: maydon DTO'da e'lon qilinmasa hamkor
 * 400 oladi. Eski tana (o'lchovsiz) o'zgarishsiz o'tishi shart.
 */

const body = (item: Record<string, unknown>) => ({
  external_order_id: 'o-1',
  elchi_market_id: '121',
  customer: { name: 'Ali', phone: '+998901234567' },
  district_id: '173',
  items: [item],
  cod_amount: 0,
});

const errorsOf = async (item: Record<string, unknown>) => {
  const dto = plainToInstance(CreatePartnerShipmentRequestDto, body(item));
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return JSON.stringify(errors);
};

const FULL = {
  name: 'Kitob',
  quantity: 2,
  external_product_id: 'p-1',
  weight_kg: 1.25,
  length_cm: 30,
  width_cm: 20,
  height_cm: 10,
};

describe('6tGZzupr — ShipmentItemDto o`lchovi', () => {
  it('o`lchov maydonlari qabul qilinadi', async () => {
    expect(await errorsOf(FULL)).toBe('[]');
  });

  it('⭐ eski hamkor tanasi (o`lchovsiz) o`zgarishsiz o`tadi', async () => {
    expect(
      await errorsOf({ name: 'Kitob', quantity: 1, external_product_id: 'p' }),
    ).toBe('[]');
    expect(await errorsOf({ name: 'Kitob' })).toBe('[]');
  });

  it('faqat og`irlik yuborish mumkin', async () => {
    expect(await errorsOf({ name: 'Kitob', weight_kg: 0.5 })).toBe('[]');
  });

  it.each<[string, Record<string, unknown>]>([
    ['nol og`irlik', { weight_kg: 0 }],
    ['manfiy og`irlik', { weight_kg: -1 }],
    ['4 kasrli og`irlik', { weight_kg: 1.1234 }],
    ['chegaradan katta og`irlik', { weight_kg: 1000.5 }],
    ['satr og`irlik', { weight_kg: '1.2' }],
    ['kasrli o`lcham', { length_cm: 30.5, width_cm: 20, height_cm: 10 }],
    ['chala o`lcham (L/W/H birga)', { length_cm: 30, width_cm: 20 }],
    ['nol o`lcham', { length_cm: 0, width_cm: 20, height_cm: 10 }],
    ['katta o`lcham', { length_cm: 1001, width_cm: 20, height_cm: 10 }],
  ])('%s — 400', async (_name, extra) => {
    expect(await errorsOf({ name: 'Kitob', ...extra })).not.toBe('[]');
  });

  it('PATCH /partner/shipments/:id ham shu DTO bilan qabul qiladi', async () => {
    const dto = plainToInstance(UpdatePartnerShipmentRequestDto, {
      items: [FULL],
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toEqual([]);
  });
});
