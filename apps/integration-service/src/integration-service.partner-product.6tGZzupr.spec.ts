import { IntegrationServiceService } from './integration-service.service';

/**
 * 6tGZzupr — hamkor posilkasidan avtomatik mahsulot:
 *   - yuborilgan o'lchov yaratilayotgan mahsulotga YOZILADI;
 *   - o'lchovsiz bo'lsa posilka RAD ETILMAYDI, mahsulot «o'lchov kutilmoqda»
 *     (o'lchov ustunlari NULL) va bu jurnalga yoziladi;
 *   - `catalog.product.create` requester bilan: hamkor yo'li `system`;
 *   - mavjud (avval o'lchovsiz yaratilgan) mahsulot — bo'sh o'lchovi to'ldiriladi.
 *
 * Prototip orqali sinaladi (`partner-product.spec` bilan bir xil uslub).
 */
function makeService(opts: {
  refRows?: any[];
  catalogFindAll?: (payload: any) => any;
  catalogCreate?: (payload: any) => any;
  catalogFill?: (payload: any) => any;
}) {
  const refRows = opts.refRows ?? [];
  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  svc.partnerProductRefRepo = {
    findOne: jest.fn(
      ({ where }: any) =>
        refRows.find(
          (r) =>
            r.partner_id === where.partner_id &&
            r.external_product_id === where.external_product_id,
        ) ?? null,
    ),
    create: jest.fn((dto: any) => ({ ...dto })),
    save: jest.fn((e: any) => ({ id: '1', ...e })),
  };
  svc.catalogClient = {};

  const create = jest.fn(opts.catalogCreate ?? (() => ({ id: 900 })));
  const fill = jest.fn(
    opts.catalogFill ?? (() => ({ data: { updated: true } })),
  );
  svc.rmqRequest = jest.fn(
    (_client: any, pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'catalog.product.find_all') {
        return Promise.resolve(
          opts.catalogFindAll
            ? opts.catalogFindAll(payload)
            : { data: [], total: 0 },
        );
      }
      if (pattern.cmd === 'catalog.product.create') {
        return Promise.resolve(create(payload));
      }
      if (pattern.cmd === 'catalog.product.fill_missing_measure') {
        return Promise.resolve(fill(payload));
      }
      return Promise.resolve(null);
    },
  );

  return { svc, create, fill };
}

const resolve = (svc: any, items: any[]) =>
  svc.resolvePartnerOrderItems('7', '55', items);

const SYSTEM = { id: 'system', roles: ['system'], via: 'partner:7' };

const MEASURE = {
  weight_kg: 1.25,
  length_cm: 30,
  width_cm: 20,
  height_cm: 10,
};

describe('6tGZzupr — hamkor mahsuloti o`lchovi', () => {
  it('⭐ yuborilgan o`lchov avtomatik yaratilgan mahsulotga yoziladi', async () => {
    const { svc, create, fill } = makeService({});

    const items = await resolve(svc, [
      { name: 'Qalam', quantity: 2, external_product_id: 'p-1', ...MEASURE },
    ]);

    expect(create).toHaveBeenCalledWith({
      dto: { name: 'Qalam', user_id: '55', ...MEASURE },
      requester: SYSTEM,
    });
    expect(fill).not.toHaveBeenCalled();
    // Buyurtma qatoriga o'lchov tushmaydi — o'lchov katalogda yashaydi.
    expect(items).toEqual([
      { product_id: '900', product_name: 'Qalam', quantity: 2 },
    ]);
    expect(svc.logger.warn).not.toHaveBeenCalled();
  });

  it('faqat og`irlik yuborilsa — faqat og`irlik yoziladi', async () => {
    const { svc, create } = makeService({});

    await resolve(svc, [
      { name: 'Qalam', external_product_id: 'p-1', weight_kg: 0.5 },
    ]);

    expect(create).toHaveBeenCalledWith({
      dto: { name: 'Qalam', user_id: '55', weight_kg: 0.5 },
      requester: SYSTEM,
    });
  });

  it('⭐ o`lchovsiz: posilka rad etilmaydi, hamkor yo`li `system`, jurnalda', async () => {
    const { svc, create } = makeService({});

    const items = await resolve(svc, [
      { name: 'Qalam', quantity: 1, external_product_id: 'p-2' },
    ]);

    expect(items).toEqual([
      { product_id: '900', product_name: 'Qalam', quantity: 1 },
    ]);
    expect(create).toHaveBeenCalledWith({
      dto: { name: 'Qalam', user_id: '55' },
      requester: SYSTEM,
    });
    expect(svc.logger.warn).toHaveBeenCalledTimes(1);
    expect(svc.logger.warn.mock.calls[0][0]).toContain('6tGZzupr');
    expect(svc.logger.warn.mock.calls[0][0]).toContain('p-2');
  });

  it('avval o`lchovsiz yaratilgan (ref bor) mahsulot: bo`sh o`lchov to`ldiriladi', async () => {
    const { svc, create, fill } = makeService({
      refRows: [
        {
          partner_id: '7',
          external_product_id: 'p-1',
          elchi_product_id: '900',
        },
      ],
    });

    const items = await resolve(svc, [
      { name: 'Qalam', external_product_id: 'p-1', ...MEASURE },
    ]);

    expect(items[0].product_id).toBe('900');
    expect(create).not.toHaveBeenCalled();
    expect(fill).toHaveBeenCalledWith({
      id: '900',
      dto: { user_id: '55', ...MEASURE },
      requester: SYSTEM,
    });
  });

  it('nom bo`yicha topilgan mahsulot ham to`ldiriladi (yangisi yaratilmaydi)', async () => {
    const { svc, create, fill } = makeService({
      catalogFindAll: () => ({
        data: [{ id: 701, name: 'Qalam' }],
        total: 1,
      }),
    });

    const items = await resolve(svc, [
      { name: 'Qalam', external_product_id: 'p-3', ...MEASURE },
    ]);

    expect(items[0].product_id).toBe('701');
    expect(create).not.toHaveBeenCalled();
    expect(fill).toHaveBeenCalledWith({
      id: '701',
      dto: { user_id: '55', ...MEASURE },
      requester: SYSTEM,
    });
  });

  it('o`lchovsiz item — mavjud mahsulotga catalog chaqiruvi YO`Q (eski xulq)', async () => {
    const { svc, fill } = makeService({
      refRows: [
        {
          partner_id: '7',
          external_product_id: 'p-1',
          elchi_product_id: '900',
        },
      ],
    });

    await resolve(svc, [{ name: 'Qalam', external_product_id: 'p-1' }]);

    expect(fill).not.toHaveBeenCalled();
  });

  it('o`lchovni to`ldirib bo`lmasa posilka yiqilmaydi', async () => {
    const { svc } = makeService({
      refRows: [
        {
          partner_id: '7',
          external_product_id: 'p-1',
          elchi_product_id: '900',
        },
      ],
      catalogFill: () => null,
    });

    const items = await resolve(svc, [
      { name: 'Qalam', external_product_id: 'p-1', ...MEASURE },
    ]);

    expect(items[0].product_id).toBe('900');
  });

  it('external_product_id siz o`lchov: katalogga bog`lanmaydi, ogohlantirish yoziladi', async () => {
    const { svc, create } = makeService({});

    const items = await resolve(svc, [{ name: 'Qalam', ...MEASURE }]);

    expect(items).toEqual([
      { product_id: null, product_name: 'Qalam', quantity: 1 },
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(svc.logger.warn).toHaveBeenCalledTimes(1);
    expect(svc.logger.warn.mock.calls[0][0]).toContain('external_product_id');
  });
});
