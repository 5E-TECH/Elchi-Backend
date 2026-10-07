import { OrderServiceService } from './order-service.service';

/** `order.summary_by_ids` (tokhPLMP): faqat jadvalga kerakli maydonlar, ≤100 id. */
describe('findSummariesByIds', () => {
  const setup = () => {
    const orderRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: '1001',
          status: 'waiting',
          total_price: '150000.00',
          customer_id: '5',
          market_id: '7',
          district_id: '101',
          region_id: '11',
        },
      ]),
    };
    const service = Object.create(
      OrderServiceService.prototype,
    ) as OrderServiceService;
    Object.assign(service, { orderRepo });
    jest
      .spyOn(service as any, 'enrichOrders')
      .mockImplementation((rows: any[]) =>
        Promise.resolve(
          rows.map((row) => ({
            ...row,
            order_number: '1001',
            market: {
              id: '7',
              name: 'Yandex',
              market_tg_token: 'MAXFIY',
              tariff_home: 30000,
            },
            customer: {
              id: '5',
              name: ' Ali ',
              phone_number: '+998901234567',
              district: { name: 'Chilonzor' },
            },
            region: { name: 'Toshkent' },
            district: { name: 'Chilonzor' },
          })),
        ),
      );
    return { service, orderRepo };
  };

  it('qisqa xulosa: maxfiy market maydonlari yo‘q', async () => {
    const { service } = setup();
    const res: any = await service.findSummariesByIds(['1001']);
    expect(res.data).toEqual([
      {
        id: '1001',
        order_number: '1001',
        status: 'waiting',
        total_price: 150000,
        customer_name: 'Ali',
        customer_phone: '+998901234567',
        region_name: 'Toshkent',
        district_name: 'Chilonzor',
      },
    ]);
    expect(JSON.stringify(res)).not.toMatch(/MAXFIY|tariff/);
  });

  it('noto‘g‘ri/takror id lar tashlanadi va 100 tadan oshmaydi', async () => {
    const { service, orderRepo } = setup();
    const ids = [
      ...Array.from({ length: 150 }, (_, i) => String(i + 1)),
      '1',
      'abc',
      null,
    ];
    await service.findSummariesByIds(ids);
    const where = orderRepo.find.mock.calls[0][0].where;
    expect(where.id.value).toHaveLength(100);
    expect(where.isDeleted).toBe(false);
  });

  it('bo‘sh ro‘yxat — so‘rovsiz bo‘sh javob', async () => {
    const { service, orderRepo } = setup();
    const res: any = await service.findSummariesByIds(undefined);
    expect(res.data).toEqual([]);
    expect(orderRepo.find).not.toHaveBeenCalled();
  });
});
