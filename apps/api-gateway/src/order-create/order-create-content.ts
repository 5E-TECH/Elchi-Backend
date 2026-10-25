import { BadRequestException } from '@nestjs/common';
import { registerDecorator, type ValidationArguments } from 'class-validator';
import {
  ORDER_CREATE_NO_DISTRICT_MESSAGE,
  ORDER_CREATE_NO_ITEMS_MESSAGE,
  orderCreateIdOrNull,
  orderCreateItemsProblem,
} from '@app/common';

/**
 * IR2OHIiN — gateway qatlami: mahsulotsiz / tumansiz buyurtma so'rovi
 * order-service'ga (va identity'ga — yetim mijoz) yetib bormaydi. Qoida va
 * matnlar — `libs/common/src/order/order-create-content.ts`; yakuniy (himoya
 * chuqurligi) tekshiruv order-service `OrderLifecycleService.create` da.
 */

/** Tuman manbasi bo'la oladigan maydonlar (`CreateOrderRequestDto` qismi). */
export interface OrderCreateDistrictSource {
  district_id?: unknown;
  customer_id?: unknown;
  customer?: { district_id?: unknown } | null;
}

/**
 * Buyurtmaga yoziladigan tuman: buyurtmaning `district_id` si, bo'lmasa
 * inline mijozniki. `null` — mavjud mijoz (`customer_id`) tumani
 * order-service'da aniqlanadi.
 */
export function orderCreateDistrictId(
  dto: OrderCreateDistrictSource,
): string | null {
  return (
    orderCreateIdOrNull(dto?.district_id) ??
    orderCreateIdOrNull(dto?.customer?.district_id)
  );
}

/** Tuman bormi yoki mavjud mijozdan olinadimi (`customer_id`). */
export function hasOrderCreateDistrictSource(
  dto: OrderCreateDistrictSource,
): boolean {
  return (
    orderCreateDistrictId(dto) !== null ||
    orderCreateIdOrNull(dto?.customer_id) !== null
  );
}

/**
 * `createOrderInternal` boshida (mijoz yaratilishidan OLDIN): `POST /orders`
 * DTO'si allaqachon tekshirgan, lekin bot va AI yo'llari DTO'ni ichkarida
 * yig'adi — ValidationPipe'dan o'tmaydi.
 */
export function assertOrderCreateContent(
  dto: OrderCreateDistrictSource & { items?: unknown },
): void {
  const itemsProblem = orderCreateItemsProblem(dto?.items);
  if (itemsProblem) {
    throw new BadRequestException(itemsProblem);
  }
  if (!hasOrderCreateDistrictSource(dto)) {
    throw new BadRequestException(ORDER_CREATE_NO_DISTRICT_MESSAGE);
  }
}

/**
 * DTO: `items` — bo'sh bo'lmagan massiv. Bitta xabar (IsArray + ArrayMinSize
 * juftligi yo'qlikda ikki marta bir xil matn berardi); qator ichi
 * (`quantity ≥ 1` va h.k.) — `@ValidateNested` + `OrderItemDto`.
 */
export function IsOrderCreateItems(): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isOrderCreateItems',
      target: target.constructor,
      propertyName: String(propertyName),
      validator: {
        validate: (value: unknown) => Array.isArray(value) && value.length > 0,
        defaultMessage: () => ORDER_CREATE_NO_ITEMS_MESSAGE,
      },
    });
  };
}

/**
 * Tuman ID berilganmi: `undefined` / `null` / bo'sh (yoki faqat probel) satr —
 * berilmagan. `CreateOrderCustomerDto.district_id` ning `@ValidateIf` i —
 * berilmagan bo'lsa ichki tekshiruv o'tkazib yuboriladi (xabar buyurtma
 * darajasida, `IsOrderCreateDistrict`).
 */
export function isProvidedDistrictId(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    !(typeof value === 'string' && value.trim() === '')
  );
}

/**
 * IR2OHIiN (prod tester, 2026-10-26): inline mijoz (`customer` obyekti)
 * tumansiz — ilgari ichki DTO'ning inglizcha xatolari («customer.district_id
 * must be a string. customer.district_id should not be empty») bilan rad
 * etilardi; endi AYNI qoida buyurtma darajasida, bitta o'zbekcha xabar bilan.
 */
function inlineCustomerLacksDistrict(dto: OrderCreateDistrictSource): boolean {
  const customer = dto?.customer;
  return (
    !!customer &&
    typeof customer === 'object' &&
    !Array.isArray(customer) &&
    !isProvidedDistrictId(customer.district_id)
  );
}

/**
 * DTO: buyurtmaning `district_id` si — berilsa bo'sh bo'lmagan satr; berilmasa
 * tuman inline mijozda (`customer.district_id`) yoki mavjud mijozda
 * (`customer_id`, order-service aniqlaydi) bo'lishi shart. Inline mijoz
 * berilgan bo'lsa — uning tumani ham shart (ilgari ichki DTO talab qilardi).
 * ⚠️ `@IsOptional` QO'YILMAYDI — u yo'q qiymatda butun tekshiruvni o'chirib
 * yuborardi.
 */
export function IsOrderCreateDistrict(): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isOrderCreateDistrict',
      target: target.constructor,
      propertyName: String(propertyName),
      validator: {
        validate: (value: unknown, args: ValidationArguments) => {
          if (
            inlineCustomerLacksDistrict(
              args.object as OrderCreateDistrictSource,
            )
          ) {
            return false;
          }
          if (value !== undefined && value !== null && value !== '') {
            return typeof value === 'string' && value.trim() !== '';
          }
          return hasOrderCreateDistrictSource(
            args.object as OrderCreateDistrictSource,
          );
        },
        defaultMessage: (args: ValidationArguments) =>
          args.value !== undefined &&
          args.value !== null &&
          args.value !== '' &&
          typeof args.value !== 'string'
            ? "district_id satr (tuman ID) bo'lishi kerak"
            : ORDER_CREATE_NO_DISTRICT_MESSAGE,
      },
    });
  };
}
