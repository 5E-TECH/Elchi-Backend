/**
 * POST /orders, /orders/external, /orders/telegram/bot/create — mijoz
 * telefoni NORMALLASHTIRILADI (zfPNDCCr).
 *
 * Prod UI testi (2026-10-09): admin "Buyurtma yaratish" yo'lida backend
 * telefonni xom satr sifatida qabul qilardi (`@IsString()` xolos) — himoya
 * faqat frontend maskasida edi. To'g'ridan-to'g'ri API'ga "998887009150",
 * "+998 88 700 91 50", "88 700 91 50" yuborilsa, identity mijozni XOM satr
 * bo'yicha qidirgani uchun bitta odam bir nechta mijozga bo'linardi;
 * "not-a-phone" esa 201 bilan o'tardi.
 *
 * Global ValidationPipe bilan bir xil sozlama (`transform: true` —
 * `plainToInstance` `@Transform` ni ishga tushiradi).
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateExternalOrderRequestDto,
  CreateOrderByTelegramBotRequestDto,
  CreateOrderRequestDto,
} from './dto/order.swagger.dto';

const orderBody = (phone: unknown) => ({
  market_id: '37',
  customer: {
    name: 'TEST Claude G5 mijoz',
    phone_number: phone,
    district_id: '173',
  },
  district_id: '173',
  where_deliver: 'center',
  items: [{ product_id: '5', quantity: 1 }],
  total_price: 15000,
});

const botBody = (phone: unknown) => ({
  name: 'TEST Claude G5 mijoz',
  phone_number: phone,
  district_id: '173',
  order_item_info: [{ product_id: '5', quantity: 1 }],
  total_price: 15000,
});

type Cls =
  | typeof CreateOrderRequestDto
  | typeof CreateExternalOrderRequestDto
  | typeof CreateOrderByTelegramBotRequestDto;

const check = async (cls: Cls, body: Record<string, unknown>) => {
  const instance = plainToInstance(cls, body) as unknown as Record<
    string,
    unknown
  >;
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat: string[] = [];
  const walk = (list: typeof errors, prefix = '') => {
    for (const e of list) {
      flat.push(prefix + e.property);
      if (e.children?.length) walk(e.children, `${prefix}${e.property}.`);
    }
  };
  walk(errors);
  return { instance, errors: flat };
};

const CANONICAL = '+998887009150';
/** Prod testida kiritilgan shakllar (results/zfPNDCCr.json). */
const SAME_PERSON = [
  '998887009150',
  '+998887009150',
  '+998 88 700 91 50',
  '+998 (88) 700-91-50',
  '88 700 91 50',
  '(88) 700-91-50',
  '887009150',
  '0887009150',
  998887009150,
];
const INVALID = [
  'not-a-phone',
  '12345',
  '+1 202 555 0100',
  '88700915', // 8 xona — TO'LDIRILMAYDI
  '+99888700915012', // 14 xona — KESILMAYDI
  '',
];

describe('POST /orders — customer.phone_number (zfPNDCCr)', () => {
  it.each(SAME_PERSON)(
    "⭐ %p → '+998887009150' (bitta mijoz kaliti)",
    async (phone) => {
      const { instance, errors } = await check(
        CreateOrderRequestDto,
        orderBody(phone),
      );
      expect(errors).toEqual([]);
      expect((instance.customer as Record<string, unknown>).phone_number).toBe(
        CANONICAL,
      );
    },
  );

  it.each(INVALID)('⭐ %p → 400 (customer.phone_number)', async (phone) => {
    const { errors } = await check(CreateOrderRequestDto, orderBody(phone));
    expect(errors).toContain('customer.phone_number');
  });
});

describe('POST /orders/external — customer.phone_number (zfPNDCCr)', () => {
  it("'998887009150' → '+998887009150'", async () => {
    const { instance, errors } = await check(
      CreateExternalOrderRequestDto,
      orderBody('998887009150'),
    );
    expect(errors).toEqual([]);
    expect((instance.customer as Record<string, unknown>).phone_number).toBe(
      CANONICAL,
    );
  });

  it("'not-a-phone' → 400", async () => {
    const { errors } = await check(
      CreateExternalOrderRequestDto,
      orderBody('not-a-phone'),
    );
    expect(errors).toContain('customer.phone_number');
  });
});

describe('POST /orders/telegram/bot/create — phone_number (zfPNDCCr)', () => {
  it("'+998 88 700 91 50' → '+998887009150'", async () => {
    const { instance, errors } = await check(
      CreateOrderByTelegramBotRequestDto,
      botBody('+998 88 700 91 50'),
    );
    expect(errors).toEqual([]);
    expect(instance.phone_number).toBe(CANONICAL);
  });

  it("'not-a-phone' → 400", async () => {
    const { errors } = await check(
      CreateOrderByTelegramBotRequestDto,
      botBody('not-a-phone'),
    );
    expect(errors).toContain('phone_number');
  });
});
