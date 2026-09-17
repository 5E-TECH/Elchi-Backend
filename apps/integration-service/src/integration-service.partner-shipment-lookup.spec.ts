import { RpcException } from '@nestjs/microservices';
import { IntegrationServiceService } from './integration-service.service';

/**
 * `GET|POST /partner/shipments/:id` — posilkani topish.
 *
 * NEGA BU TEST BOR. Ilgari qidiruv to'g'ridan-to'g'ri `order_id` (bigint)
 * ustunida bajarilardi, hujjat esa marshrutni `:external_order_id` deb
 * yozgan edi. Hujjatdagidek UUID yuborilsa, Postgres bigint ustunga matnni
 * sig'dirolmay `22P02` berardi va API **500** qaytarardi — "topilmadi" emas,
 * "server buzildi".
 */
function makeService(rows: any[]) {
  const findOne = jest.fn(async ({ where }: any) => {
    // Haqiqiy Postgres xulqini taqlid qilamiz: bigint ustunga raqam bo'lmagan
    // qiymat berilsa, so'rovning O'ZI yiqiladi.
    if (where.order_id !== undefined && !/^\d+$/.test(String(where.order_id))) {
      const err: any = new Error(
        'invalid input syntax for type bigint: "' + where.order_id + '"',
      );
      err.code = '22P02';
      throw err;
    }
    return (
      rows.find(
        (r) =>
          r.partner_id === where.partner_id &&
          (where.order_id !== undefined
            ? r.order_id === where.order_id
            : r.external_order_id === where.external_order_id),
      ) ?? null
    );
  });

  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.partnerShipmentRefRepo = { findOne };
  return { svc, findOne };
}

const ROW = {
  partner_id: '7',
  order_id: '121',
  external_order_id: '75b1423e-30a4-4a23-9cb8-e868e720b015',
};

describe('findPartnerShipmentRef — ikki id shakli ham qabul qilinadi', () => {
  it('TC1: raqamli id → Elchi order_id bo‘yicha topiladi', async () => {
    const { svc } = makeService([ROW]);
    const ref = await svc.findPartnerShipmentRef('7', '121');
    expect(ref.order_id).toBe('121');
  });

  it('TC2: UUID (external_order_id) → 500 EMAS, topiladi', async () => {
    const { svc, findOne } = makeService([ROW]);
    const ref = await svc.findPartnerShipmentRef('7', ROW.external_order_id);
    expect(ref.order_id).toBe('121');
    // ⭐ Asosiy shart: bigint ustunga UMUMAN tegilmadi.
    for (const [{ where }] of findOne.mock.calls as any[]) {
      expect(where.order_id).toBeUndefined();
    }
  });

  it('TC3: topilmagan UUID → 404 (500 emas)', async () => {
    const { svc } = makeService([ROW]);
    await expect(
      svc.findPartnerShipmentRef('7', 'yo-such-thing'),
    ).rejects.toBeInstanceOf(RpcException);
    await svc.findPartnerShipmentRef('7', 'yo-such-thing').catch((e: any) => {
      expect(e.getError().statusCode).toBe(404);
    });
  });

  it('TC4: boshqa hamkorning posilkasi KO‘RINMAYDI', async () => {
    const { svc } = makeService([ROW]);
    await expect(svc.findPartnerShipmentRef('9', '121')).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('TC5: raqamli external_order_id ishlatgan hamkor ham topiladi', async () => {
    // Hamkor marketplace id'si raqamli bo'lsa: order_id bo'yicha topilmaydi,
    // keyin external_order_id bo'yicha topiladi.
    const { svc } = makeService([
      { partner_id: '7', order_id: '500', external_order_id: '1001' },
    ]);
    const ref = await svc.findPartnerShipmentRef('7', '1001');
    expect(ref.order_id).toBe('500');
  });
});
