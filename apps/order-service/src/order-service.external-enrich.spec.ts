import { of } from 'rxjs';
import { OrderServiceService } from './order-service.service';

/**
 * e5L3RMRu — kiruvchi posilkalar skani (/orders/external → order.external.
 * find_all) har qatorda mijoz ismi/telefoni va tuman nomini beradi.
 *
 * Ildiz sabab 9b1b951 (DL6FCdrh) da yopilgan: findAllExternal endi
 * findAllEnriched → enrichOrders yo'lidan o'tadi. Bu spec shu kontraktni va
 * N+1 yo'qligini qotiradi: 100 posilka uchun identity/logistics ga HAR BIR
 * tur bo'yicha BITTA find_by_ids partiya so'rovi.
 */
type Pattern = { cmd: string };

const ORDERS = Array.from({ length: 100 }, (_, index) => ({
  id: String(1251100 + index),
  market_id: '121',
  // 100 posilka — 40 ta mijoz, 7 ta tuman (takrorlar bitta id bo'ladi).
  customer_id: String(150 + (index % 40)),
  district_id: String(170 + (index % 7)),
  region_id: '3',
  courier_id: null,
  post_id: null,
  status: 'new',
  total_price: 200000,
  items: [],
}));

const build = () => {
  const respond = (pattern: Pattern, payload: { ids?: string[] }) => {
    const ids = payload?.ids ?? [];
    switch (pattern.cmd) {
      case 'identity.customer.find_by_ids':
        return of({
          data: ids.map((id) => ({
            id,
            name: `Mijoz ${id}`,
            phone_number: `+99899111${id.padStart(4, '0')}`,
          })),
        });
      case 'identity.market.find_by_ids':
        return of({ data: ids.map((id) => ({ id, name: 'Uzum' })) });
      case 'logistics.district.find_by_ids':
        return of({
          data: ids.map((id) => ({ id, name: `Tuman ${id}`, region_id: '3' })),
        });
      case 'logistics.region.find_by_ids':
        return of({ data: ids.map((id) => ({ id, name: 'Andijon' })) });
      default:
        return of({ data: [] });
    }
  };
  const identityClient = { send: jest.fn(respond) };
  const logisticsClient = { send: jest.fn(respond) };
  const catalogClient = { send: jest.fn(respond) };

  const service = Object.create(
    OrderServiceService.prototype,
  ) as OrderServiceService;
  Object.assign(service, {
    identityClient,
    logisticsClient,
    catalogClient,
    dataSource: { query: jest.fn().mockResolvedValue([]) },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  const findAll = jest.spyOn(service, 'findAll').mockResolvedValue({
    data: ORDERS,
    total: ORDERS.length,
    page: 1,
    limit: 200,
    total_pages: 1,
    totalPages: 1,
  } as never);

  const callsOf = (client: { send: jest.Mock }, cmd: string) =>
    client.send.mock.calls.filter(
      ([pattern]) => (pattern as Pattern).cmd === cmd,
    );
  return { service, findAll, identityClient, logisticsClient, callsOf };
};

describe("e5L3RMRu — skan ro'yxatida mijoz ismi va tuman", () => {
  it('/orders/external elementlarida customer {name, phone_number} va district {name} bor', async () => {
    const { service, findAll } = build();
    const res = await service.findAllExternal({
      market_id: '121',
      status: 'new',
      limit: 100,
    });

    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'external', market_id: '121' }),
    );
    expect(res.data).toHaveLength(100);
    const first = res.data[0] as unknown as {
      customer: {
        name: string;
        phone_number: string;
        district: { name: string };
      };
      district: { name: string };
      order_number: string;
    };
    expect(first.customer).toMatchObject({
      name: 'Mijoz 150',
      phone_number: '+998991110150',
    });
    expect(first.district).toMatchObject({ name: 'Tuman 170' });
    expect(first.customer.district).toMatchObject({ name: 'Tuman 170' });
    expect(first.order_number).toBeTruthy();
    // Hech bir qatorda "—" bo'ladigan bo'sh mijoz/tuman yo'q.
    for (const row of res.data as unknown as Array<{
      customer?: { name?: string };
      district?: { name?: string };
    }>) {
      expect(row.customer?.name).toBeTruthy();
      expect(row.district?.name).toBeTruthy();
    }
  });

  it("N+1 yo'q: 100 posilka → har tur uchun BITTA find_by_ids (noyob id'lar bilan)", async () => {
    const { service, identityClient, logisticsClient, callsOf } = build();
    await service.findAllExternal({ market_id: '121', limit: 100 });

    const customerCalls = callsOf(
      identityClient,
      'identity.customer.find_by_ids',
    );
    const districtCalls = callsOf(
      logisticsClient,
      'logistics.district.find_by_ids',
    );
    expect(customerCalls).toHaveLength(1);
    expect(districtCalls).toHaveLength(1);
    expect((customerCalls[0][1] as { ids: string[] }).ids).toHaveLength(40);
    expect((districtCalls[0][1] as { ids: string[] }).ids).toHaveLength(7);
    // Bittalab so'rov (find_by_id) umuman ketmaydi.
    expect(
      callsOf(identityClient, 'identity.customer.find_by_id'),
    ).toHaveLength(0);
    expect(
      callsOf(logisticsClient, 'logistics.district.find_by_id'),
    ).toHaveLength(0);
  });

  it("identity javob bermasa ro'yxat yiqilmaydi (customer bo'sh obyekt, district qoladi)", async () => {
    const { service, identityClient } = build();
    identityClient.send.mockImplementation(() => of({ data: [] }));
    const res = await service.findAllExternal({ market_id: '121' });
    expect(res.data).toHaveLength(100);
    expect(
      (res.data[0] as unknown as { district: { name: string } }).district.name,
    ).toBe('Tuman 170');
  });
});
