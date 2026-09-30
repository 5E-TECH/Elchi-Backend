/**
 * ROLLBACK SIMMETRIYASI — sotuvni bekor qilish kassalarni AYNAN sotuvdan
 * oldingi holatga qaytarishi shart (bironta so'm sizib chiqmasin).
 *
 * ── MUAMMO TARIXI (E2E Andijon, P0) ─────────────────────────────────────────
 * Ilgari `sale_collectible_amount` SAQLANMASDI, shuning uchun rollback
 * `saleCollectible` ni `total_price` ga tushirib yuborardi. Agar mijoz onlayn
 * to'lagan bo'lsa (`collectible = total_price − paid_online < total_price`),
 * rollback sotuvga qaraganda KO'PROQ pul qaytarardi va farq jimgina yig'ilardi.
 *
 * TUZATISH (fix 35369b4c): sotuv `sale_collectible_amount = collectible` ni
 * (kassa oyoqlariga AYNAN yozilgan summa) snapshot qiladi; rollback aynan
 * shuni o'qib teskari yozadi. Rollback har oyoqni quyidagi formula bilan
 * qaytaradi (order-lifecycle.service.ts):
 *
 *   market  reversal = saleCollectible − marketTariff
 *   courier reversal = saleCollectible − courierShare
 *   branch  reversal = saleCollectible − courierShare − branchShare
 *
 * Bu AYNAN sotuv `computeSaleLegs` yozgan `*Amount` oyoqlari bo'lishi kerak —
 * aks holda rollback sotuvni to'liq teskari qilmaydi. Bu test production
 * `computeSaleLegs` ni rollback kutgan formulaga MIXLAB qo'yadi: kelajakda
 * biri o'zgarib ikkinchisidan ajralib ketsa (pul sizishi), shu yerda yiqiladi.
 */
import { computeSaleLegs } from './domain/order-money';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Rollback production formulasi (order-lifecycle.service.ts:2223-2230). */
function rollbackReversal(
  saleCollectible: number,
  marketTariff: number,
  courierShare: number,
  branchShare: number,
) {
  return {
    market: round2(saleCollectible - marketTariff),
    courier: round2(saleCollectible - courierShare),
    branch: round2(saleCollectible - courierShare - branchShare),
  };
}

describe('Rollback simmetriyasi — sotuv oyoqlari = rollback teskari oyoqlari', () => {
  function* cases(): Generator<{
    total: number;
    marketTariff: number;
    courierShare: number;
    branchShare: number;
  }> {
    let seed = 987654321;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let k = 0; k < 500; k++) {
      const total = round2(next() * 1_000_000);
      const marketTariff = round2(next() * total);
      const courierShare = round2(next() * marketTariff);
      const branchShare = round2(next() * (marketTariff - courierShare));
      yield { total, marketTariff, courierShare, branchShare };
    }
  }

  it('SAQLANGAN holat: rollback AYNAN sotuv oyoqlarini teskari qiladi (net 0)', () => {
    for (const c of cases()) {
      const legs = computeSaleLegs(c);
      // saleCollectible = sotuvdagi `total` (snapshot qilingan) — simmetrik.
      const rev = rollbackReversal(
        c.total,
        c.marketTariff,
        c.courierShare,
        c.branchShare,
      );
      // Sotuv yozgan har oyoq AYNAN rollback qaytargan oyoqqa teng bo'lishi shart.
      expect(rev.market).toBe(legs.marketAmount);
      expect(rev.courier).toBe(legs.courierAmount);
      expect(rev.branch).toBe(legs.branchAmount);
    }
  });

  it('NULL fallback (eski buyurtma): faqat collectible == total_price bo`lsa to`g`ri', () => {
    // Onlayn to'lovsiz (eski buyurtma): collectible == total_price -> aynan.
    const marketTariff = 30000;
    const courierShare = 20000;
    const branchShare = 0;
    const collectible = 400000;
    const totalPrice = 400000; // paid_online = 0
    const saleLegs = computeSaleLegs({
      total: collectible,
      marketTariff,
      courierShare,
      branchShare,
    });
    const revNull = rollbackReversal(
      totalPrice,
      marketTariff,
      courierShare,
      branchShare,
    );
    expect(revNull.courier).toBe(saleLegs.courierAmount); // farq YO'Q

    // Onlayn to'lov bo'lsa (collectible < total_price) VA saqlanmagan bo'lsa,
    // null->total_price fallback KO'PROQ qaytarardi. Aynan shu sabab
    // `sale_collectible_amount` endi SAQLANADI.
    const collectibleOnline = 380000; // paid_online = 20000
    const saleLegsOnline = computeSaleLegs({
      total: collectibleOnline,
      marketTariff,
      courierShare,
      branchShare,
    });
    const revNullOnline = rollbackReversal(
      totalPrice,
      marketTariff,
      courierShare,
      branchShare,
    );
    const drift = round2(revNullOnline.courier - saleLegsOnline.courierAmount);
    expect(drift).toBe(20000); // = paid_online — snapshot busiz yig'ilardigan xato
    // Snapshot BILAN (saleCollectible = collectible) drift yo'qoladi:
    const revPersisted = rollbackReversal(
      collectibleOnline,
      marketTariff,
      courierShare,
      branchShare,
    );
    expect(revPersisted.courier).toBe(saleLegsOnline.courierAmount);
  });
});
