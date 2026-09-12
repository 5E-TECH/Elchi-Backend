import { IntegrationServiceService } from './integration-service.service';

/**
 * INTEGRATSIYA TAKSONOMIYASI — rol / kategoriya / rejim.
 *
 * Ilgari modelda faqat `type` (`api`/`webhook`/`ftp`) bor edi — u TRANSPORT,
 * ya'ni "qanday gaplashamiz". "NIMA QILADI" degan savol hech qayerda
 * yozilmasdi: yetkazuvchi (bizdan posilka oladi) va manba (bizga buyurtma
 * beradi) bir xil ko'rinardi. To'lov tizimi yoki marketplace uchun esa
 * umuman joy yo'q edi.
 */
function svc() {
  return Object.create(IntegrationServiceService.prototype) as any;
}

describe('Rol normalizatori', () => {
  it('TC1: haqiqiy rollar o‘zgarmaydi', () => {
    const s = svc();
    for (const role of ['carrier', 'source', 'payment', 'mirror']) {
      expect(s.normalizeRole(role)).toBe(role);
    }
  });

  it('TC2: BOSH HARF va bo‘shliq tozalanadi', () => {
    // UI yoki tashqi chaqiruvchi "Marketplace", " SOURCE " yuborishi mumkin.
    // Xom qiymat bazaga tushsa filtr va guruhlash buzilardi.
    const s = svc();
    expect(s.normalizeRole('  SOURCE ')).toBe('source');
    expect(s.normalizeRole('Payment')).toBe('payment');
  });

  it("TC3: noma'lum/bo‘sh -> `carrier`", () => {
    /**
     * ⭐ Nega `carrier`: MAVJUD integratsiyalarning hammasi shu naqshda
     * (`dispatch_config` bilan posilka yaratamiz, ular COD qarzdor). Mavjud
     * chaqiruvchilar `role` yubormaydi — ular xato bermasligi kerak.
     */
    const s = svc();
    expect(s.normalizeRole(undefined)).toBe('carrier');
    expect(s.normalizeRole(null)).toBe('carrier');
    expect(s.normalizeRole('')).toBe('carrier');
    expect(s.normalizeRole('allaqanday')).toBe('carrier');
  });
});

describe('Kategoriya normalizatori', () => {
  it('TC4: ruxsat etilganlar o‘zgarmaydi', () => {
    const s = svc();
    for (const c of [
      'marketplace',
      'crm',
      'cargo',
      'payment',
      'spreadsheet',
      'other',
    ]) {
      expect(s.normalizeCategory(c)).toBe(c);
    }
  });

  it("TC5: noma'lum -> `other` (rad etilmaydi)", () => {
    // Taksonomiya o'sadi; noma'lum qiymatni rad etish onboarding'ni
    // to'sardi. `other` — "hali tasniflanmagan" degani.
    const s = svc();
    expect(s.normalizeCategory('bitrix24')).toBe('other');
    expect(s.normalizeCategory(undefined)).toBe('other');
  });
});

describe('Rejim normalizatori', () => {
  it('TC6: `spec` ATAYLAB tanlanadi, qolgani `adapter`', () => {
    /**
     * `spec` — biz kontrakt e'lon qilganimizni bildiradi, ya'ni hamkor
     * bizning qoidamizni bajaradi. Bu ataylab qilinadigan qaror, shuning
     * uchun standart EMAS.
     */
    const s = svc();
    expect(s.normalizeIntegrationMode('spec')).toBe('spec');
    expect(s.normalizeIntegrationMode('SPEC')).toBe('spec');
    expect(s.normalizeIntegrationMode('adapter')).toBe('adapter');
    expect(s.normalizeIntegrationMode(undefined)).toBe('adapter');
    expect(s.normalizeIntegrationMode('nimadir')).toBe('adapter');
  });
});

describe('Yaratishda taksonomiya yoziladi', () => {
  function makeSvc() {
    const created: any[] = [];
    const s = svc();
    s.integrationRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: any) => {
        created.push(x);
        return x;
      }),
      save: jest.fn(async (x: any) => ({ id: '1', ...x })),
    };
    s.activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    s.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    s.encryptCredential = jest.fn((v: string) => `enc:${v}`);
    /**
     * SSRF guard DNS'ga murojaat qiladi — test tarmoqqa BOG'LIQ bo'lmasligi
     * kerak (guard'ning o'zi alohida sinaladi). Mock bo'lmasa test mavjud
     * domenlarda o'tib, mavjud bo'lmaganlarida yiqilardi.
     */
    s.assertOutboundUrlSafe = jest.fn().mockResolvedValue(undefined);
    return { s, created };
  }

  it('TC7: berilgan rol/kategoriya/rejim saqlanadi', async () => {
    const { s, created } = makeSvc();

    await s.createIntegration({
      name: 'Uzum Market',
      base_url: 'https://api.uzum.uz',
      role: 'SOURCE',
      category: 'Marketplace',
      integration_mode: 'spec',
    });

    expect(created[0].role).toBe('source');
    expect(created[0].category).toBe('marketplace');
    expect(created[0].integration_mode).toBe('spec');
  });

  it('TC8: berilmasa mavjud xulq saqlanadi (carrier/other/adapter)', async () => {
    // Eski chaqiruvchilar bu maydonlarni yubormaydi — buzilmasliklari kerak.
    const { s, created } = makeSvc();

    await s.createIntegration({
      name: 'Eski Cargo',
      base_url: 'https://api.eski.uz',
    });

    expect(created[0].role).toBe('carrier');
    expect(created[0].category).toBe('other');
    expect(created[0].integration_mode).toBe('adapter');
  });
});
