import {
  exportDay,
  exportPeriod,
  orderExportSubtitle,
} from './order-export-subtitle';

describe('buyurtma eksporti banneri matni', () => {
  it('davr: kun, ISO lahza (Toshkent kuni), ochiq chetlar', () => {
    expect(exportDay('2026-11-16')).toBe('16.11.2026');
    expect(exportDay('2026-11-16T20:30:00.000Z')).toBe('17.11.2026');
    expect(exportDay('kecha')).toBe('');
    expect(exportPeriod('2026-11-16', '2026-11-25')).toBe(
      '16.11.2026 – 25.11.2026',
    );
    expect(exportPeriod('2026-11-16', '2026-11-16')).toBe('16.11.2026');
    expect(exportPeriod('2026-11-16', undefined)).toBe('16.11.2026 dan');
    expect(exportPeriod(undefined, '2026-11-25')).toBe('25.11.2026 gacha');
    expect(exportPeriod(undefined, undefined)).toBe('barchasi');
  });

  it('holat va bosqich o‘zbekcha; ko‘p bo‘lsa qisqaradi; qidiruv', () => {
    expect(
      orderExportSubtitle({
        status: ['sold', 'paid,closed'],
        cancel_stage: 'branch',
        search: ' Ali ',
      }),
    ).toBe(
      "Davr: barchasi · Holat: Sotilgan, To'langan, Yopilgan, Bekor · filialda · Qidiruv: Ali",
    );
    expect(
      orderExportSubtitle({ status: 'new,created,received,sold,paid,closed' }),
    ).toBe(
      'Davr: barchasi · Holat: Yangi, Yaratilgan, Qabul qilindi, Sotilgan va yana 2 ta',
    );
  });

  it('market / viloyat / kuryer nomi faqat mos qatordan; topilmasa qo‘yilmaydi', () => {
    const rows = [
      { market: { id: 2, name: 'Boshqa' }, region: null, courier: 'x' },
      {
        market: { id: '37', name: 'Baraka Shop' },
        region: { id: '3', name: 'Andijon viloyati' },
        courier: { id: '26', name: 'Jasur' },
      },
    ];
    expect(
      orderExportSubtitle(
        { market_id: '37', region_id: '3', courier_id: '26' },
        rows,
      ),
    ).toBe(
      'Davr: barchasi · Holat: barchasi · Market: Baraka Shop · Viloyat: Andijon viloyati · Kuryer: Jasur',
    );
    expect(
      orderExportSubtitle({ market_id: '99', district_id: '1' }, rows),
    ).toBe('Davr: barchasi · Holat: barchasi');
  });
});
