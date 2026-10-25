import { RpcException } from '@nestjs/microservices';
import {
  ORDER_CREATE_NO_DISTRICT_MESSAGE,
  orderCreateIdOrNull,
  orderCreateItemsProblem,
} from '@app/common';
import { Order_source } from '../entities/order.entity';

/**
 * IR2OHIiN — buyurtma MAZMUNI (mahsulot + tuman) yaratishning YAGONA nuqtasida
 * (`OrderLifecycleService.create`) tekshiriladi. Qoida va xabarlar —
 * `libs/common/src/order/order-create-content.ts`.
 *
 * Bu nuqtaga keladigan yo'llar: `POST /orders` (market, market operatori,
 * registrator, menejer/filial — «Qabul va yaratish», admin/superadmin;
 * almashtirish `replaced_order_id` ham shu yerdan), AI `ai-confirm`, Telegram
 * bot (`POST /orders/telegram/bot/create`), ombor manbali yaratish
 * (`fulfillment`), `POST /orders/external` (`createExternalOrder` — o'zi
 * chaqiradi), hamkor posilkasi va tashqi saytlar importi (chiqarilgan,
 * pastga qarang).
 */

/** integration-service hamkor posilkasida (`createPartnerShipment`) so'rovchi id prefiksi. */
export const PARTNER_REQUESTER_PREFIX = 'partner:';

/**
 * HAMKOR / INTEGRATSIYA YARATISHI — qoidadan ATAYLAB chiqarilgan (ega qoidasi:
 * BeePost va integratsiya kodi Shodiyorniki, bu kartada o'zgartirilmaydi).
 *
 *  - BeePost `POST /partner/shipments` → integration-service
 *    `createPartnerShipment` → `order.create` (`source: 'external'`,
 *    so'rovchi `partner:<id>`). `district_id` u yerda majburiy, lekin `items`
 *    ixtiyoriy (nomsiz / miqdori ≤ 0 qatorlar jimgina tashlanadi) — qoida
 *    qo'llansa mahsulotsiz posilka 400 olib, hamkor oqimi uzilardi.
 *  - Tashqi saytlar importi `order.receive_external` (`receiveExternalOrders`,
 *    order-service ichida, so'rovchisiz) — `items` saytdan kelmasa bo'sh;
 *    qoida tsikl o'rtasida 400 otib, partiyani yarim yo'lda uzardi.
 *
 * Ikkalasi `source = external` + (so'rovchi yo'q YOKI `partner:` prefiksi).
 * Gateway'dan keladigan har so'rovda so'rovchi — JWT `sub` (raqam), ya'ni
 * `POST /orders` ga superadmin `source: 'external'` yuborsa ham chiqarilMAYDI.
 * `POST /orders/external` ham so'rovchisiz `create()` ni chaqiradi — shu bois
 * `createExternalOrder` qoidani O'ZI, `create()` dan oldin qo'llaydi.
 */
export function isIntegrationOrderCreate(
  dto: { source?: unknown } | null | undefined,
  requester?: { id?: unknown } | null,
): boolean {
  const source =
    typeof dto?.source === 'string' ? dto.source.trim().toLowerCase() : '';
  if (source !== String(Order_source.EXTERNAL)) {
    return false;
  }
  const rawRequesterId = requester?.id;
  const requesterId =
    typeof rawRequesterId === 'string' || typeof rawRequesterId === 'number'
      ? String(rawRequesterId).trim()
      : '';
  return requesterId === '' || requesterId.startsWith(PARTNER_REQUESTER_PREFIX);
}

export interface OrderCreateContentLookup {
  getCustomerDistrictId(
    customerId: string | null | undefined,
  ): Promise<string | null>;
  resolveRegionIdForDistrict(
    districtId: string | null | undefined,
  ): Promise<string | null>;
}

function badRequest(message: string): never {
  throw new RpcException({ statusCode: 400, message });
}

/**
 * Mahsulot va tumanni tekshiradi; buyurtmaga YOZILADIGAN `district_id` va
 * `region_id` ni qaytaradi (aks holda 400, o'zbekcha xabar).
 *
 * Tuman: buyurtmaning `district_id` si, bo'lmasa mavjud mijozniki
 * (`customer_id` → identity). Viloyat: tuman buyurtmaning o'zida va viloyat
 * ham berilgan bo'lsa — o'zgarmaydi; aks holda tumandan
 * (`resolveRegionIdForDistrict` — LC-13 / YfWZXu9g bilan AYNI tartib:
 * avval `assigned_region`), aniqlanmasa — berilgani (yoki `null`, qabulda
 * to'ldiriladi).
 */
export async function resolveOrderCreateContent(
  dto: {
    items?: unknown;
    district_id?: unknown;
    region_id?: unknown;
    customer_id?: unknown;
  },
  lookup: OrderCreateContentLookup,
): Promise<{ district_id: string; region_id: string | null }> {
  const itemsProblem = orderCreateItemsProblem(dto?.items);
  if (itemsProblem) {
    badRequest(itemsProblem);
  }

  const ownDistrictId = orderCreateIdOrNull(dto?.district_id);
  const districtId =
    ownDistrictId ??
    (await lookup.getCustomerDistrictId(orderCreateIdOrNull(dto?.customer_id)));
  if (!districtId) {
    badRequest(ORDER_CREATE_NO_DISTRICT_MESSAGE);
  }

  const givenRegionId = orderCreateIdOrNull(dto?.region_id);
  if (ownDistrictId && givenRegionId) {
    return { district_id: districtId, region_id: givenRegionId };
  }
  const regionFromDistrict =
    await lookup.resolveRegionIdForDistrict(districtId);
  return {
    district_id: districtId,
    region_id: regionFromDistrict ?? givenRegionId,
  };
}
