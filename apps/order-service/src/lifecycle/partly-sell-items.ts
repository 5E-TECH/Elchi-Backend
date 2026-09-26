import { RpcException } from '@nestjs/microservices';

/**
 * QISMAN SOTUV: so'rovdagi qatorlarni buyurtma qatorlariga moslash.
 *
 * ⚠️ Ilgari moslash FAQAT `product_id` bo'yicha edi. Hamkor (Partner API /
 * BeePost) posilkalarida mahsulot katalogda yo'q — `order_items.product_id`
 * null, nomi `product_name` da. Bunday buyurtmani qisman sotishning umuman
 * iloji yo'q edi ("Product not found in request: null").
 *
 * Endi qator avval `order_item_id` (buyurtma qatorining o'z id'si), keyin
 * eski usulda `product_id` bo'yicha topiladi. Xato xabarlari avvalgidek.
 */
export type PartlySellRequestItem = {
  order_item_id?: string | number | null;
  product_id?: string | number | null;
  quantity: number;
};

type ExistingOrderItem = {
  id: string;
  product_id: string | null;
  product_name?: string | null;
  quantity: number;
};

export type PartlySellCancelledItem = {
  product_id: string | null;
  product_name: string | null;
  quantity: number;
};

const fail = (statusCode: 400 | 404, message: string): never => {
  throw new RpcException({ statusCode, message });
};

const hasValue = (value: string | number | null | undefined) =>
  value !== null && value !== undefined && String(value) !== '';

export function matchPartlySellItems<T extends ExistingOrderItem>(
  existingItems: T[],
  requestItems: PartlySellRequestItem[],
): {
  matches: Array<{ item: T; quantity: number }>;
  cancelledItems: PartlySellCancelledItem[];
} {
  const findRequestItem = (item: T) =>
    requestItems.find(
      (requestItem) =>
        hasValue(requestItem.order_item_id) &&
        String(requestItem.order_item_id) === String(item.id),
    ) ??
    requestItems.find(
      (requestItem) =>
        item.product_id !== null &&
        hasValue(requestItem.product_id) &&
        String(requestItem.product_id) === String(item.product_id),
    );

  const matches = existingItems.map((item) => {
    const requestItem = findRequestItem(item);
    if (!requestItem) {
      return fail(404, `Product not found in request: ${item.product_id}`);
    }
    if (Number(requestItem.quantity) > Number(item.quantity)) {
      return fail(
        400,
        `Quantity cannot exceed original amount for product ${item.product_id}`,
      );
    }
    return { item, quantity: Number(requestItem.quantity) };
  });

  for (const requestItem of requestItems) {
    if (hasValue(requestItem.order_item_id)) {
      if (
        !existingItems.some(
          (item) => String(item.id) === String(requestItem.order_item_id),
        )
      ) {
        fail(
          404,
          `Order item not found in order: ${requestItem.order_item_id}`,
        );
      }
    } else if (
      !existingItems.some(
        (item) =>
          item.product_id !== null &&
          String(item.product_id) === String(requestItem.product_id),
      )
    ) {
      fail(404, `Product not found in order: ${requestItem.product_id}`);
    }
  }

  const cancelledItems = matches
    .filter(({ item, quantity }) => Number(item.quantity) - quantity > 0)
    .map(({ item, quantity }) => ({
      // Katalogsiz qatorda product_id null QOLADI va nomi saqlanadi (ilgari
      // "null" matni bigint ustunga yozilardi).
      product_id: item.product_id !== null ? String(item.product_id) : null,
      product_name:
        item.product_id === null ? (item.product_name ?? null) : null,
      quantity: Number(item.quantity) - quantity,
    }));

  return { matches, cancelledItems };
}
