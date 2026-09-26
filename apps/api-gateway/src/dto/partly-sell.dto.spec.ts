import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PartlySellOrderRequestDto } from './order.swagger.dto';

/**
 * POST /orders/partly-sell — `order_item_info[]` qatori.
 *
 * ⚠️ Ilgari `product_id` majburiy string edi va `order_item_id` e'lon
 * qilinmagan edi — `forbidNonWhitelisted` (`main.ts`) tufayli uni yuborish
 * 400 berardi. Katalogsiz (hamkor) qatorda `product_id` null bo'lgani uchun
 * bunday buyurtmani qisman sotishning umuman yo'li yo'q edi.
 */
describe('PartlySellOrderRequestDto — order_item_info qatorlari', () => {
  const errorsFor = async (item: Record<string, unknown>) => {
    const dto = plainToInstance(PartlySellOrderRequestDto, {
      order_item_info: [item],
      totalPrice: 500000,
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.flatMap((error) =>
      (error.children ?? []).flatMap((row) =>
        (row.children ?? []).map((field) => field.property),
      ),
    );
  };

  it('katalogsiz qator: order_item_id, product_id null — qabul qilinadi', async () => {
    expect(
      await errorsFor({ order_item_id: '5501', product_id: null, quantity: 1 }),
    ).toEqual([]);
    expect(await errorsFor({ order_item_id: '5501', quantity: 1 })).toEqual([]);
  });

  it('eski usul: faqat product_id — avvalgidek qabul qilinadi', async () => {
    expect(await errorsFor({ product_id: '4', quantity: 3 })).toEqual([]);
  });

  it('ikkalasi ham — qabul qilinadi (servis mosligini tekshiradi)', async () => {
    expect(
      await errorsFor({ order_item_id: '1', product_id: '4', quantity: 3 }),
    ).toEqual([]);
  });

  it("hech bir id yo'q yoki bo'sh — product_id xatosi", async () => {
    expect(await errorsFor({ quantity: 1 })).toContain('product_id');
    expect(await errorsFor({ product_id: '', quantity: 1 })).toContain(
      'product_id',
    );
    expect(
      await errorsFor({ order_item_id: '', product_id: null, quantity: 1 }),
    ).toEqual(expect.arrayContaining(['order_item_id', 'product_id']));
  });
});
