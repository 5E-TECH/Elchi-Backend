import { isIpAllowed, normalizeIp } from './ip-allowlist.util';

/**
 * IP ALLOWLIST.
 *
 * ⚠️ MUAMMONING TARIXI: `partners.ip_allowlist` ustuni bazada, admin API'da va
 * UI'da bor edi, lekin HECH QAYERDA TEKSHIRILMASDI. Operator uni to'ldirib
 * kirish cheklangan deb o'ylardi — aslida har qanday IP'dan ishlardi.
 * Yolg'on xavfsizlik hissi yo'qligidan YOMONROQ, chunki u boshqa choralar
 * ko'rishni to'sadi.
 */
describe('normalizeIp', () => {
  it("TC1: IPv4-mapped IPv6 prefiksi kesiladi", () => {
    /**
     * ⭐ Node `::ffff:203.0.113.10` shaklida berishi mumkin. Xom holda
     * solishtirilsa ro'yxatdagi `203.0.113.10` bilan MOS KELMASDI — ya'ni
     * to'g'ri sozlangan allowlist ham hamkorni bloklab qo'yardi.
     */
    expect(normalizeIp('::ffff:203.0.113.10')).toBe('203.0.113.10');
  });

  it('TC2: bo‘shliq va bosh harf tozalanadi', () => {
    expect(normalizeIp('  203.0.113.10  ')).toBe('203.0.113.10');
    expect(normalizeIp('::FFFF:203.0.113.10')).toBe('203.0.113.10');
  });

  it('TC3: IPv4 portli shakl kesiladi, IPv6 esa SAQLANADI', () => {
    expect(normalizeIp('203.0.113.10:5678')).toBe('203.0.113.10');
    // IPv6 da ikki nuqta manzilning O'ZIDA bor — kesilmasligi kerak.
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it("TC4: bo‘sh qiymat bo‘sh satr", () => {
    expect(normalizeIp(undefined)).toBe('');
    expect(normalizeIp(null)).toBe('');
    expect(normalizeIp('   ')).toBe('');
  });
});

describe('isIpAllowed', () => {
  it("TC5: ⭐ ro‘yxat BO‘SH -> RUXSAT (mavjud hamkorlar buzilmasin)", () => {
    /**
     * Ataylab: hamkorlarning ko'pchiligida statik IP bo'lmaydi va bo'sh
     * ro'yxatni "hech kimga ruxsat yo'q" deb tushunish barcha mavjud
     * integratsiyani bir zumda o'chirib qo'yardi.
     */
    expect(isIpAllowed('203.0.113.10', null)).toBe(true);
    expect(isIpAllowed('203.0.113.10', [])).toBe(true);
    expect(isIpAllowed('203.0.113.10', ['', '  '])).toBe(true);
  });

  it('TC6: aniq moslik', () => {
    expect(isIpAllowed('203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(isIpAllowed('203.0.113.11', ['203.0.113.10'])).toBe(false);
  });

  it('TC7: ro‘yxatdagi BIRORTASI mos kelsa yetarli', () => {
    expect(
      isIpAllowed('198.51.100.7', ['203.0.113.10', '198.51.100.7']),
    ).toBe(true);
  });

  it('TC8: CIDR diapazoni', () => {
    // Hamkorlar odatda diapazondan chiqadi; aks holda operator 256 ta
    // qator yozishi kerak bo'lardi.
    expect(isIpAllowed('203.0.113.77', ['203.0.113.0/24'])).toBe(true);
    expect(isIpAllowed('203.0.114.1', ['203.0.113.0/24'])).toBe(false);
    expect(isIpAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
  });

  it('TC9: `/32` bitta manzil, `/0` hammasi', () => {
    expect(isIpAllowed('203.0.113.10', ['203.0.113.10/32'])).toBe(true);
    expect(isIpAllowed('203.0.113.11', ['203.0.113.10/32'])).toBe(false);
    expect(isIpAllowed('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
  });

  it("TC10: ⭐ IP ANIQLANMASA va ro‘yxat BOR -> RAD", () => {
    /**
     * Ataylab: cheklov qo'yilgan joyda "IP'ni bilmadim, o'tkazib yuboraman"
     * degan xulq cheklovni ma'nosiz qilardi.
     */
    expect(isIpAllowed(undefined, ['203.0.113.10'])).toBe(false);
    expect(isIpAllowed('', ['203.0.113.10'])).toBe(false);
  });

  it('TC11: XATO CIDR mos kelmaydi (jimgina ruxsat bermaydi)', () => {
    // Buzilgan qoida "hammaga ruxsat" ga aylanmasligi kerak.
    expect(isIpAllowed('203.0.113.10', ['203.0.113.0/99'])).toBe(false);
    expect(isIpAllowed('203.0.113.10', ['203.0.113.0/abc'])).toBe(false);
    expect(isIpAllowed('203.0.113.10', ['not-an-ip/24'])).toBe(false);
  });

  it('TC12: soxta IPv4 shakllari rad etiladi', () => {
    // `Number('1e2')` = 100 — oddiy parse bilan "1e2.0.0.1" o'tib ketardi.
    expect(isIpAllowed('1e2.0.0.1', ['100.0.0.1'])).toBe(false);
    expect(isIpAllowed('203.0.113.999', ['203.0.113.0/24'])).toBe(false);
    expect(isIpAllowed('203.0.113', ['203.0.113.0/24'])).toBe(false);
  });

  it('TC13: mapped IPv6 mijoz + IPv4 qoidasi MOS KELADI', () => {
    // Eng ko'p uchraydigan amaliy holat.
    expect(isIpAllowed('::ffff:203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(isIpAllowed('::ffff:203.0.113.10', ['203.0.113.0/24'])).toBe(true);
  });
});
