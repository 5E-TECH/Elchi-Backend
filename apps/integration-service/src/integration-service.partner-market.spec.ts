import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';

/**
 * provisionPartnerMarket (C1.5) — prototip orqali sinaladi (og'ir konstruktorsiz).
 */
function makeService(
  refRepo: Record<string, jest.Mock>,
  identitySend: jest.Mock,
  log: jest.Mock,
) {
  const svc = Object.create(IntegrationServiceService.prototype);
  svc.partnerMarketRefRepo = refRepo;
  svc.identityClient = { send: identitySend };
  svc.activityLog = { log };
  return svc as IntegrationServiceService;
}

const baseDto = {
  partner_id: '7',
  external_seller_id: 'shop-9',
  name: 'Zamon Store',
  phone: '+998901234567',
};

describe('IntegrationServiceService.provisionPartnerMarket (C1.5)', () => {
  it('TC1/TC3: yangi -> market.create chaqiriladi, ref (partner_id bilan) saqlanadi, id qaytadi', async () => {
    const saved: any[] = [];
    const refRepo = {
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: any) => {
        saved.push(x);
        return Promise.resolve({ id: '1', ...x });
      }),
    };
    const identity = jest.fn(() => of({ data: { id: 500 } }));
    const log = jest.fn(() => Promise.resolve(undefined));
    const svc = makeService(refRepo, identity, log);

    const res: any = await svc.provisionPartnerMarket({ ...baseDto });

    expect(res.statusCode).toBe(201);
    expect(res.data.elchi_market_id).toBe('500');
    // identity.market.create bir marta, sensible dto bilan
    expect(identity).toHaveBeenCalledWith(
      { cmd: 'identity.market.create' },
      expect.objectContaining({
        dto: expect.objectContaining({
          name: 'Zamon Store',
          phone_number: '+998901234567',
          username: expect.any(String),
          default_tariff: 'center',
        }),
        requester: expect.objectContaining({ id: 'partner:7' }),
      }),
    );
    // TC3: ref partner_id bilan bog'langan
    expect(saved[0]).toEqual({
      partner_id: '7',
      external_seller_id: 'shop-9',
      elchi_market_id: '500',
    });
    expect(log).toHaveBeenCalled();
  });

  it('mLVtpIBa: hamkor marketi cancelled_handover_qr_required=false bilan ochiladi (API-only hamkor tokensiz yopadi)', async () => {
    const refRepo = {
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: any) => Promise.resolve({ id: '1', ...x })),
    };
    const identity = jest.fn(() => of({ data: { id: 501 } }));
    const svc = makeService(
      refRepo,
      identity,
      jest.fn(() => Promise.resolve(undefined)),
    );

    await svc.provisionPartnerMarket({ ...baseDto });

    expect(identity).toHaveBeenCalledWith(
      { cmd: 'identity.market.create' },
      expect.objectContaining({
        dto: expect.objectContaining({
          cancelled_handover_qr_required: false,
        }),
      }),
    );
  });

  it('TC2: idempotent — mavjud ref bo‘lsa yangi market ochilmaydi', async () => {
    const refRepo = {
      findOne: jest.fn(() => Promise.resolve({ elchi_market_id: '500' })),
      create: jest.fn(),
      save: jest.fn(),
    };
    const identity = jest.fn();
    const svc = makeService(refRepo, identity, jest.fn());

    const res: any = await svc.provisionPartnerMarket({ ...baseDto });

    expect(res.statusCode).toBe(200);
    // `tariff_updated` 2026-09-11 da qo'shildi: takroriy chaqiruv endi tarifni
    // yangilay oladi (hamkor integratsiyani buzmasdan tarifni o'zgartirsin).
    // Bu yerda dto'da tarif YO'Q, shuning uchun hech nima yangilanmaydi.
    expect(res.data).toEqual({
      elchi_market_id: '500',
      idempotent: true,
      tariff_updated: false,
    });
    expect(identity).not.toHaveBeenCalled(); // market.create YO'Q
    expect(refRepo.save).not.toHaveBeenCalled();
  });

  it('C1.46: mavjud marketning uy va markaz tarifi yangilanadi', async () => {
    const refRepo = {
      findOne: jest.fn(() => Promise.resolve({ elchi_market_id: '500' })),
      create: jest.fn(),
      save: jest.fn(),
    };
    const identity = jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'identity.market.find_by_id'
        ? of({ data: { tariff_home: 0, tariff_center: 0 } })
        : of({ data: { id: '500' } }),
    );
    const log = jest.fn(() => Promise.resolve(undefined));
    const svc = makeService(refRepo, identity, log);

    const res: any = await svc.provisionPartnerMarket({
      ...baseDto,
      tariff_home: 25000,
      tariff_center: 15000,
    });

    expect(res.data).toEqual({
      elchi_market_id: '500',
      idempotent: true,
      tariff_updated: true,
    });
    expect(identity).toHaveBeenCalledWith(
      { cmd: 'identity.market.update' },
      expect.objectContaining({
        id: '500',
        dto: { tariff_home: 25000, tariff_center: 15000 },
      }),
    );
    expect(identity).not.toHaveBeenCalledWith(
      { cmd: 'identity.market.create' },
      expect.anything(),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: { tariff_home: 0, tariff_center: 0 },
        new_value: { tariff_home: 25000, tariff_center: 15000 },
      }),
    );
  });

  it('external_seller_id yo‘q -> 400 (RpcException)', async () => {
    const svc = makeService(
      { findOne: jest.fn() } as any,
      jest.fn(),
      jest.fn(),
    );
    await expect(
      svc.provisionPartnerMarket({ partner_id: '7', name: 'x', phone: 'y' }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('market yaratilmasa (id yo‘q) -> 502', async () => {
    const refRepo = {
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(),
      save: jest.fn(),
    };
    const identity = jest.fn(() => of({ data: {} })); // id yo'q
    const svc = makeService(refRepo, identity, jest.fn());

    await expect(
      svc.provisionPartnerMarket({ ...baseDto }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(refRepo.save).not.toHaveBeenCalled();
  });
});

/**
 * QISMAN TARIF YANGILASH — JIM PUL XATOSI (audit MP-CODE-1).
 *
 * ⚠️ NIMA BUZILGAN EDI. `Number(dto.tariff_home ?? 0)` — hamkor FAQAT
 * `tariff_center` yuborsa (markaz kelishuvi o'zgargan, uyga yetkazish
 * o'zgarmagan), `tariff_home` jimgina 0 ga tushardi. 0 tarif = UYGA
 * YETKAZISH BEPUL. Hech qanday xato chiqmasdi, hech kim bilmasdi.
 *
 * Bu xato ayniqsa marketplace uchun xavfli: ular REST API bilan ishlaydi va
 * faqat o'zgargan maydonni yuborish — mutlaqo normal amaliyot.
 */
describe('⭐ provisionPartnerMarket — QISMAN tarif yangilash (MP-CODE-1)', () => {
  const existingRef = { id: '1', elchi_market_id: '500' };

  /** `identity.market.find_by_id` mavjud tarifni qaytaradi, keyin update. */
  const buildSvc = (current: {
    tariff_home: number;
    tariff_center: number;
  }) => {
    const refRepo = {
      findOne: jest.fn(() => Promise.resolve(existingRef)),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: any) => Promise.resolve(x)),
    };
    const calls: any[] = [];
    const identity = jest.fn((pattern: any, payload: any) => {
      calls.push({ pattern, payload });
      if (pattern.cmd === 'identity.market.find_by_id') {
        return of({ data: current });
      }
      return of({ data: { id: 500 } });
    });
    const svc = makeService(
      refRepo,
      identity,
      jest.fn(() => Promise.resolve()),
    );
    return { svc, calls };
  };

  const updateDto = (calls: any[]) =>
    calls.find((c) => c.pattern.cmd === 'identity.market.update')?.payload?.dto;

  it('⭐ faqat `tariff_center` yuborilsa `tariff_home` SAQLANADI', async () => {
    const { svc, calls } = buildSvc({
      tariff_home: 25000,
      tariff_center: 15000,
    });

    await svc.provisionPartnerMarket({ ...baseDto, tariff_center: 20000 });

    expect(updateDto(calls)).toEqual({
      // O'zgarmagan maydon MAVJUD qiymatida qoldi, 0 ga tushmadi.
      tariff_home: 25000,
      tariff_center: 20000,
    });
  });

  it('⭐ faqat `tariff_home` yuborilsa `tariff_center` SAQLANADI', async () => {
    const { svc, calls } = buildSvc({
      tariff_home: 25000,
      tariff_center: 15000,
    });

    await svc.provisionPartnerMarket({ ...baseDto, tariff_home: 30000 });

    expect(updateDto(calls)).toEqual({
      tariff_home: 30000,
      tariff_center: 15000,
    });
  });

  it('ikkisi yuborilsa ikkisi ham yangilanadi', async () => {
    const { svc, calls } = buildSvc({
      tariff_home: 25000,
      tariff_center: 15000,
    });

    await svc.provisionPartnerMarket({
      ...baseDto,
      tariff_home: 30000,
      tariff_center: 20000,
    });

    expect(updateDto(calls)).toEqual({
      tariff_home: 30000,
      tariff_center: 20000,
    });
  });

  it('hech biri yuborilmasa tarifga UMUMAN tegilmaydi', async () => {
    /**
     * "Idempotent takroriy chaqiruv" holati: hamkor faqat market id'sini
     * olish uchun chaqiradi. Tarif o'qilmaydi ham, yozilmaydi ham.
     */
    const { svc, calls } = buildSvc({
      tariff_home: 25000,
      tariff_center: 15000,
    });

    const res: any = await svc.provisionPartnerMarket({ ...baseDto });

    expect(updateDto(calls)).toBeUndefined();
    expect(res.data.tariff_updated).toBe(false);
  });

  it('⭐ 0 ATAYLAB yuborilsa — qabul qilinadi (bepul yetkazish kelishuvi)', async () => {
    /**
     * `0` ni butunlay taqiqlash ham xato bo'lardi: bepul yetkazish
     * kelishuvi mumkin. Farq shundaki, endi u ATAYLAB yuborilganda
     * qo'llanadi, yuborilmaganda esa emas.
     */
    const { svc, calls } = buildSvc({
      tariff_home: 25000,
      tariff_center: 15000,
    });

    await svc.provisionPartnerMarket({ ...baseDto, tariff_home: 0 });

    expect(updateDto(calls)).toEqual({
      tariff_home: 0,
      tariff_center: 15000,
    });
  });
});
