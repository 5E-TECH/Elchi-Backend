/**
 * TARIF QO'RIQCHISI — market tarifi kuryer (+ hamkor filial) ulushini qoplamasa
 * sotuv RAD ETILADI.
 *
 * NEGA. COD zanjiri marketga `total − marketTariff` to'laydi, lekin yuqoriga
 * faqat `total − courierShare − branchShare` ko'tariladi. Tarif ikki ulushni
 * qoplamasa, HQ marketga OLGANIDAN KO'P to'laydi: 500 000 so'mlik buyurtmada
 * kuryer 25 000 ni o'ziga oladi, 475 000 topshiradi, market tarifi 20 000
 * bo'lsa marketga 480 000 to'lanadi — har buyurtmada 5 000 so'm HQ kissasidan.
 * Ilgari bu holat hech qanday xato bermasdi: `sell_profit` jimgina manfiy
 * bo'lib yozilardi (`money-conservation` testi esa ulushlarni ATAYLAB tarif
 * ICHIDAN olardi, ya'ni bu holat sinovdan tashqarida qolgan edi).
 *
 * Qo'riqchi tranzaksiyadan OLDIN ishlaydi, shuning uchun rad etilgan sotuvda
 * birorta kassa oyog'i yozilmaydi.
 */
import { RpcException } from '@nestjs/microservices';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import {
  computeSaleLegs,
  computeTariffShortfall,
  resolveOrderTariff,
} from './domain/order-money';

type TariffGuard = (params: {
  marketTariff: number;
  courierShare: number;
  branchShare: number;
}) => void;

/**
 * Faqat qo'riqchi metodi kerak — uni prototipdan olamiz, ya'ni repozitoriy, RMQ
 * klientlari va tranzaksiya mocklari umuman talab qilinmaydi (`sellOrder` ni
 * to'liq taqlid qilish bu invariantni tekshirish uchun ortiqcha).
 */
function guard(): TariffGuard {
  const s = Object.create(OrderLifecycleService.prototype) as {
    assertTariffCoversShares: TariffGuard;
  };
  return (params) => s.assertTariffCoversShares(params);
}

describe('computeTariffShortfall', () => {
  it('tarif ulushlarni qoplasa 0 qaytaradi', () => {
    expect(computeTariffShortfall(25_000, 25_000, 0)).toBe(0);
    expect(computeTariffShortfall(30_000, 25_000, 5_000)).toBe(0);
    expect(computeTariffShortfall(30_000, 25_000, 0)).toBe(0);
  });

  it('qoplamasa yetishmagan summani qaytaradi', () => {
    expect(computeTariffShortfall(20_000, 25_000, 0)).toBe(5_000);
    // Tarif umuman sozlanmagan market: butun kuryer haqqi zarar bo'ladi.
    expect(computeTariffShortfall(0, 25_000, 0)).toBe(25_000);
    // Hamkor filial ulushi ham hisobga olinadi.
    expect(computeTariffShortfall(25_000, 20_000, 8_000)).toBe(3_000);
  });

  it('bir tiyinlik yaxlitlash shovqinini zarar deb hisoblamaydi', () => {
    expect(computeTariffShortfall(25_000, 25_000.01, 0)).toBe(0);
    expect(computeTariffShortfall(25_000, 25_000.02, 0)).toBe(0.02);
  });

  it('oyliq (salary-only) kuryerda ulush 0 — zarar yo`q', () => {
    expect(computeTariffShortfall(0, 0, 0)).toBe(0);
  });
});

describe('assertTariffCoversShares', () => {
  it('tarif qoplasa o`tkazadi', () => {
    expect(() =>
      guard()({ marketTariff: 25_000, courierShare: 25_000, branchShare: 0 }),
    ).not.toThrow();
  });

  it('qoplamasa 400 bilan rad etadi va raqamlarni xabarga qo`shadi', () => {
    let error: unknown;
    try {
      guard()({ marketTariff: 20_000, courierShare: 25_000, branchShare: 0 });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RpcException);
    const payload = (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
    expect(payload.statusCode).toBe(400);
    expect(payload.message).toContain('20000');
    expect(payload.message).toContain('25000');
    // Yetishmagan summa — operator nimani to'g'rilashini bilishi uchun.
    expect(payload.message).toContain('5000');
    // Filial ulushi 0 bo'lsa, filial haqida gap ketmaydi.
    expect(payload.message).not.toContain('filial ulushi');
  });

  it('hamkor filial ulushi ham xabarda ko`rinadi', () => {
    let message = '';
    try {
      guard()({
        marketTariff: 25_000,
        courierShare: 20_000,
        branchShare: 8_000,
      });
    } catch (err) {
      message = String(
        ((err as RpcException).getError() as { message: string }).message,
      );
    }
    expect(message).toContain('filial ulushi');
    expect(message).toContain('8000');
    expect(message).toContain('3000');
  });

  it('qoplamaydigan sotuvda HQ haqiqatan zarar ko`rardi (identikani ko`rsatadi)', () => {
    const legs = computeSaleLegs({
      total: 500_000,
      marketTariff: 20_000,
      courierShare: 25_000,
      branchShare: 0,
    });
    // Yuqoriga ko'tarilgan naqd < marketga to'lanishi kerak bo'lgan summa.
    expect(legs.courierAmount).toBe(475_000);
    expect(legs.marketAmount).toBe(480_000);
    expect(legs.hqProfit).toBe(-5_000);
    expect(computeTariffShortfall(20_000, 25_000, 0)).toBe(
      legs.marketAmount - legs.courierAmount,
    );
  });
});

/**
 * Tarif tanlash MANBASI bitta: `resolveOrderTariff`. Ilgari `sellOrder` faqat
 * live profildan olardi, `partlySellOrder` va rollback esa buyurtmadagi
 * snapshotni ustun qo'yardi — override qo'yilgan buyurtmada kassa oyog'i bir
 * tarif bilan, `sell_profit` va rollback boshqa tarif bilan hisoblanardi.
 */
describe('resolveOrderTariff', () => {
  it('buyurtmadagi override har doim ustun', () => {
    expect(
      resolveOrderTariff({
        snapshot: 35_000,
        isCenter: false,
        centerTariff: 8_000,
        homeTariff: 10_000,
      }),
    ).toBe(35_000);
    // 0 ham haqiqiy override — `??` bilan adashtirilmaydi.
    expect(
      resolveOrderTariff({
        snapshot: 0,
        isCenter: true,
        centerTariff: 8_000,
        homeTariff: 10_000,
      }),
    ).toBe(0);
  });

  it('override bo`lmasa yetkazish turiga mos live tarif', () => {
    expect(
      resolveOrderTariff({
        snapshot: null,
        isCenter: true,
        centerTariff: 8_000,
        homeTariff: 10_000,
      }),
    ).toBe(8_000);
    expect(
      resolveOrderTariff({
        snapshot: undefined,
        isCenter: false,
        centerTariff: 8_000,
        homeTariff: 10_000,
      }),
    ).toBe(10_000);
  });

  it('sozlanmagan tarif 0 ga aylanadi (qo`riqchi shu holatni tutadi)', () => {
    expect(
      resolveOrderTariff({
        snapshot: null,
        isCenter: false,
        centerTariff: 8_000,
        homeTariff: null,
      }),
    ).toBe(0);
  });
});
