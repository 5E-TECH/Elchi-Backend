import { RpcException } from '@nestjs/microservices';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Where_deliver } from '@app/common';

/**
 * QO'SHIMCHA XARAJAT SUMMASI CHEGARASI.
 *
 * Ilgari Elchi'da faqat "KIM yozishi mumkin" tekshirilardi, "QANCHA" esa
 * UMUMAN tekshirilmasdi — kuryer istagan summani yozib market kassasidan
 * shuncha pul yechib olardi. Yetkazish turi ham hisobga olinmasdi.
 *
 * Qoida BeePost bilan bir xil bo'lishi SHART: ikki tizim ajralsa, kuryer eng
 * bo'sh yo'lni topib ishlatadi va chegara amalda eng bo'sh joyi bo'yicha
 * ishlaydi.
 */
function svc() {
  const s: any = Object.create(OrderLifecycleService.prototype);
  s.badRequest = (m: string) => {
    throw new RpcException({ statusCode: 400, message: m });
  };
  s.hasRole = (r: any, role: string) =>
    (r?.roles ?? []).map(String).includes(String(role));
  return s;
}

const check = (p: Record<string, unknown>) =>
  svc().assertExtraCostWithinLimit({
    mode: 'sell',
    whereDeliver: Where_deliver.CENTER,
    tariffCenter: 15000,
    tariffHome: 25000,
    ...p,
  });

const msg = (fn: () => void): string => {
  try {
    fn();
    return '';
  } catch (e: any) {
    return String(e?.getError?.()?.message ?? e?.message ?? '');
  }
};

describe("Elchi — qo'shimcha xarajat chegarasi (SOTUV)", () => {
  it('TC1: uyga yetkazishda UMUMAN mumkin emas', () => {
    const m = msg(() =>
      check({ extraCost: 1, whereDeliver: Where_deliver.ADDRESS }),
    );
    expect(m).toMatch(/Uyga/);
  });

  it('TC2: markazga — maksimum uy va markaz tarifi FARQI (10000)', () => {
    expect(() => check({ extraCost: 10000 })).not.toThrow();
    expect(msg(() => check({ extraCost: 10001 }))).toMatch(/maksimal 10000/);
  });

  it("TC3: tariflar TENG bo'lsa — o'z tarifining 50%i", () => {
    // To'liq tarif ruxsat etilsa kuryer xizmat haqini ikki baravar qilib
    // olishi mumkin edi.
    expect(() =>
      check({ extraCost: 10000, tariffCenter: 20000, tariffHome: 20000 }),
    ).not.toThrow();
    expect(
      msg(() =>
        check({ extraCost: 10001, tariffCenter: 20000, tariffHome: 20000 }),
      ),
    ).toMatch(/maksimal 10000/);
  });

  it("TC4: uy tarifi markazdan KICHIK bo'lsa ham 50% (manfiy chegara YO'Q)", () => {
    expect(() =>
      check({ extraCost: 10000, tariffCenter: 20000, tariffHome: 10000 }),
    ).not.toThrow();
    expect(
      msg(() =>
        check({ extraCost: 10001, tariffCenter: 20000, tariffHome: 10000 }),
      ),
    ).toMatch(/maksimal 10000/);
  });

  it('TC5: tarif 0 -> hech narsa yozilmaydi', () => {
    expect(
      msg(() => check({ extraCost: 1, tariffCenter: 0, tariffHome: 0 })),
    ).toMatch(/maksimal 0/);
  });

  it("TC6: xarajat 0 -> tekshiruv o'tkazib yuboriladi", () => {
    expect(() =>
      check({ extraCost: 0, whereDeliver: Where_deliver.ADDRESS }),
    ).not.toThrow();
  });

  it('TC7: MANAGER chegaradan ozod (uning nazorati — tasdiqlash oqimi)', () => {
    // ⭐ Managerda tarif tushunchasi yo'q (`tariff_*` = 0). Chegarani unga
    // qo'llasak maksimum 0 chiqib, manager umuman xarajat yoza olmasdi.
    expect(() =>
      check({
        extraCost: 999999,
        tariffCenter: 0,
        tariffHome: 0,
        isManager: true,
      }),
    ).not.toThrow();
  });
});

describe("Elchi — qo'shimcha xarajat chegarasi (BEKOR QILISH)", () => {
  it('TC8: maksimum = kuryer tarifi, SOTUVDAN boshqa qoida', () => {
    // Kuryer borib qaytdi, vaqt-yoqilg'i sarfladi.
    expect(() => check({ mode: 'cancel', extraCost: 15000 })).not.toThrow();
    expect(msg(() => check({ mode: 'cancel', extraCost: 15001 }))).toMatch(
      /xizmat haqqingizdan \(15000/,
    );
  });

  it('TC9: bekor qilishda uyga yetkazish TAQIQLANMAYDI (uy tarifi olinadi)', () => {
    expect(() =>
      check({
        mode: 'cancel',
        extraCost: 25000,
        whereDeliver: Where_deliver.ADDRESS,
      }),
    ).not.toThrow();
    expect(
      msg(() =>
        check({
          mode: 'cancel',
          extraCost: 25001,
          whereDeliver: Where_deliver.ADDRESS,
        }),
      ),
    ).toMatch(/25000/);
  });
});
