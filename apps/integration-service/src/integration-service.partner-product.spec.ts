import { IntegrationServiceService } from './integration-service.service';

/**
 * Hamkor mahsulotlarini Elchi KATALOGIGA bog'lash.
 *
 * Nega bu muhim: avval hamkor posilkalari `product_id = null` bilan
 * yaratilardi. UI mahsulot nomini katalogdan olgani uchun bunday qatorda
 * yiqilardi, mahsulot bo'yicha hisobot esa hamkor tovarlarini umuman
 * ko'rmasdi.
 *
 * Prototip orqali sinaladi (og'ir konstruktorsiz) — `partner-crud.spec` bilan
 * bir xil uslub.
 */
function makeService(opts: {
  refRows?: any[];
  catalogFindAll?: (payload: any) => any;
  catalogCreate?: (payload: any) => any;
  saveRef?: (entity: any) => any;
}) {
  const refRows = opts.refRows ?? [];
  const saveRef = opts.saveRef ?? jest.fn(async (e: any) => ({ id: '1', ...e }));

  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  svc.partnerProductRefRepo = {
    findOne: jest.fn(async ({ where }: any) =>
      refRows.find(
        (r) =>
          r.partner_id === where.partner_id &&
          r.external_product_id === where.external_product_id,
      ) ?? null,
    ),
    create: jest.fn((dto: any) => ({ ...dto })),
    save: saveRef,
  };
  svc.catalogClient = {};

  // `rmqRequest`ni to'g'ridan-to'g'ri almashtiramiz: haqiqiy versiyasi
  // HAR QANDAY xatoni `null` ga aylantiradi, mock ham shunday qiladi.
  svc.rmqRequest = jest.fn(async (_client: any, pattern: { cmd: string }, payload: any) => {
    if (pattern.cmd === 'catalog.product.find_all') {
      return opts.catalogFindAll ? opts.catalogFindAll(payload) : { data: [], total: 0 };
    }
    if (pattern.cmd === 'catalog.product.create') {
      return opts.catalogCreate ? opts.catalogCreate(payload) : null;
    }
    return null;
  });

  return { svc: svc as IntegrationServiceService, saveRef };
}

const resolve = (svc: any, items: any[]) =>
  svc.resolvePartnerOrderItems('7', '55', items);

describe('Hamkor mahsuloti → Elchi katalogi', () => {
  it('TC1: katalogda yo‘q mahsulot AVTOMATIK yaratiladi va bog‘lanish saqlanadi', async () => {
    const create = jest.fn(() => ({ id: 900, name: 'Qalam' }));
    const { svc, saveRef } = makeService({
      catalogFindAll: () => ({ data: [], total: 0 }),
      catalogCreate: create,
    });

    const items = await resolve(svc, [
      { name: 'Qalam', quantity: 2, external_product_id: 'pcs-uuid-1' },
    ]);

    expect(items).toEqual([
      { product_id: '900', product_name: 'Qalam', quantity: 2 },
    ]);
    // Mahsulot HAMKORNING marketi ostida yaratiladi — boshqa marketlar
    // katalogi bulg'anmasin.
    expect(create).toHaveBeenCalledWith({
      dto: { name: 'Qalam', user_id: '55' },
    });
    expect(saveRef).toHaveBeenCalledWith(
      expect.objectContaining({
        partner_id: '7',
        external_product_id: 'pcs-uuid-1',
        elchi_product_id: '900',
        elchi_market_id: '55',
      }),
    );
  });

  it('TC2: mavjud bog‘lanish QAYTA ISHLATILADI — katalogga murojaat yo‘q', async () => {
    const findAll = jest.fn(() => ({ data: [], total: 0 }));
    const create = jest.fn(() => ({ id: 111 }));
    const { svc, saveRef } = makeService({
      refRows: [
        { partner_id: '7', external_product_id: 'pcs-uuid-1', elchi_product_id: '900' },
      ],
      catalogFindAll: findAll,
      catalogCreate: create,
    });

    const items = await resolve(svc, [
      { name: 'Qalam (yangi nom)', quantity: 1, external_product_id: 'pcs-uuid-1' },
    ]);

    // ⭐ Nom O'ZGARGAN, lekin bog'lanish ID bo'yicha — DUBLIKAT YARATILMAYDI.
    expect(items[0].product_id).toBe('900');
    expect(create).not.toHaveBeenCalled();
    expect(findAll).not.toHaveBeenCalled();
    expect(saveRef).not.toHaveBeenCalled();
  });

  it('TC3: katalogda AYNAN shu nomli mahsulot bo‘lsa, yangisi yaratilmaydi', async () => {
    const create = jest.fn(() => ({ id: 999 }));
    const { svc } = makeService({
      // ILIKE qidiruvi ortiqcha natija ham qaytaradi — faqat AYNIQ nom olinadi.
      catalogFindAll: () => ({
        data: [
          { id: 700, name: 'Qalam qutisi' },
          { id: 701, name: 'qalam' },
        ],
        total: 2,
      }),
      catalogCreate: create,
    });

    const items = await resolve(svc, [
      { name: 'Qalam', quantity: 1, external_product_id: 'pcs-uuid-2' },
    ]);

    expect(items[0].product_id).toBe('701');
    expect(create).not.toHaveBeenCalled();
  });

  it('TC4: external_product_id BERILMASA eski xulq — faqat nom (matn)', async () => {
    const create = jest.fn(() => ({ id: 5 }));
    const { svc } = makeService({ catalogCreate: create });

    const items = await resolve(svc, [{ name: 'Qalam', quantity: 3 }]);

    expect(items).toEqual([
      { product_id: null, product_name: 'Qalam', quantity: 3 },
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it('TC5: catalog javob bermasa posilka YIQILMAYDI — nom matn bo‘lib qoladi', async () => {
    const { svc } = makeService({
      catalogFindAll: () => null, // rmqRequest xatoni null ga aylantiradi
      catalogCreate: () => null,
    });

    const items = await resolve(svc, [
      { name: 'Qalam', quantity: 1, external_product_id: 'pcs-uuid-3' },
    ]);

    // Yetkazish mahsulot ma'lumotnomasidan MUHIMROQ.
    expect(items).toEqual([
      { product_id: null, product_name: 'Qalam', quantity: 1 },
    ]);
  });

  it('TC6: create dublikatga yiqilsa (poyga) — mavjud mahsulot olinadi', async () => {
    let createCalls = 0;
    let findCalls = 0;
    const { svc } = makeService({
      catalogFindAll: () => {
        findCalls += 1;
        // 1-qidiruv: hali yo'q. 2-qidiruv (create'dan keyin): boshqa oqim
        // yaratib ulgurgan.
        return findCalls === 1
          ? { data: [], total: 0 }
          : { data: [{ id: 802, name: 'Qalam' }], total: 1 };
      },
      catalogCreate: () => {
        createCalls += 1;
        return null; // `(name, user_id)` noyob → xato → rmqRequest null qaytaradi
      },
    });

    const items = await resolve(svc, [
      { name: 'Qalam', quantity: 1, external_product_id: 'pcs-uuid-4' },
    ]);

    expect(createCalls).toBe(1);
    expect(items[0].product_id).toBe('802');
  });

  it('TC7: ref saqlashda noyoblik buzilsa — mavjud bog‘lanish qaytariladi', async () => {
    const pgUnique: any = new Error('duplicate key');
    pgUnique.code = '23505';

    const { svc } = makeService({
      catalogFindAll: () => ({ data: [], total: 0 }),
      catalogCreate: () => ({ id: 900 }),
      saveRef: jest.fn(() => {
        throw pgUnique;
      }),
    });
    // Poygada g'olib oqim yozib ketgan qator: birinchi findOne null qaytardi,
    // ikkinchisi topadi.
    let findOneCalls = 0;
    (svc as any).partnerProductRefRepo.findOne = jest.fn(async () => {
      findOneCalls += 1;
      return findOneCalls === 1 ? null : { elchi_product_id: '901' };
    });

    const items = await resolve(svc, [
      { name: 'Qalam', quantity: 1, external_product_id: 'pcs-uuid-5' },
    ]);

    expect(items[0].product_id).toBe('901');
  });

  it('TC8: nomsiz/nol miqdorli qatorlar tushib qoladi', async () => {
    const { svc } = makeService({});

    const items = await resolve(svc, [
      { name: '   ', quantity: 2 },
      { name: 'Qalam', quantity: 0 },
      { name: 'Daftar', quantity: 1 },
    ]);

    expect(items).toEqual([
      { product_id: null, product_name: 'Daftar', quantity: 1 },
    ]);
  });
});
