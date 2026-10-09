/**
 * POST /orders DTO — summa va miqdor chegaralari (IDG1z5y9).
 *
 * Ilgari `total_price: -1000` va `quantity: -5` bilan buyurtma 201 bilan
 * yozilardi. Global ValidationPipe bilan bir xil sozlama.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateExternalOrderRequestDto,
  CreateOrderRequestDto,
} from './dto/order.swagger.dto';

const base = {
  market_id: '16',
  customer: {
    name: 'TEST Mijoz',
    phone_number: '+998887009201',
    district_id: '173',
  },
  district_id: '173',
  where_deliver: 'center',
  items: [{ product_id: '4', quantity: 1 }],
  total_price: 100000,
};

const errorsFor = async (
  body: Record<string, unknown>,
  cls = CreateOrderRequestDto,
) => {
  const errors = await validate(plainToInstance(cls, body), {
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
  return flat;
};

describe('CreateOrderRequestDto — summa/miqdor (IDG1z5y9)', () => {
  it('⭐ TC1: total_price=-1 → xato', async () => {
    expect(await errorsFor({ ...base, total_price: -1 })).toContain(
      'total_price',
    );
  });

  it('⭐ TC2: total_price yo`q → xato', async () => {
    const rest: Record<string, unknown> = { ...base };
    delete rest.total_price;
    expect(await errorsFor(rest)).toContain('total_price');
  });

  it.each([0, -5, 1.5])('⭐ TC3/TC4: quantity=%p → xato', async (quantity) => {
    const errors = await errorsFor({
      ...base,
      items: [{ product_id: '4', quantity }],
    });
    expect(errors.some((p) => p.endsWith('quantity'))).toBe(true);
  });

  it('⭐ TC5: items=[] → xato', async () => {
    expect(await errorsFor({ ...base, items: [] })).toContain('items');
  });

  it('⭐ TC6: total_price=0 (bepul buyurtma) — o`tadi', async () => {
    expect(await errorsFor({ ...base, total_price: 0 })).toEqual([]);
  });

  it('oddiy to`g`ri buyurtma — o`tadi; quantity berilmasa ham (sukut 1)', async () => {
    expect(await errorsFor(base)).toEqual([]);
    expect(await errorsFor({ ...base, items: [{ product_id: '4' }] })).toEqual(
      [],
    );
  });

  it('POST /orders/external ham shu qoidaga bo`ysunadi (meros DTO)', async () => {
    expect(
      await errorsFor(
        { ...base, total_price: -1, external_id: 'x' },
        CreateExternalOrderRequestDto,
      ),
    ).toContain('total_price');
  });
});
