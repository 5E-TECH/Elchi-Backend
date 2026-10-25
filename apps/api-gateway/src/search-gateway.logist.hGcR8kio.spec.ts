import { of, throwError } from 'rxjs';
import { LogistRegionScopeService } from './auth/logist-scope';
import { SearchGatewayController } from './search-gateway.controller';

/**
 * hGcR8kio — GET /search: logist uchun gateway o'z viloyatlarini
 * (logistics `region.find_by_logist`) `requester.region_ids` sifatida
 * uzatadi. Xato/xizmat yo'q — `[]` (fail-closed: search-service faqat
 * viloyat/tuman nomlarini beradi). Boshqa rollar payloadi o'zgarmagan.
 */
const searchReply = { success: true, data: { items: [], meta: {} } };

function setup(scope: LogistRegionScopeService | null) {
  const search = { send: jest.fn(() => of(searchReply)) };
  const identity = { send: jest.fn(() => of({ data: { market_id: '7' } })) };
  const controller = new SearchGatewayController(
    search as never,
    identity as never,
    scope ?? undefined,
  );
  return { controller, search, identity };
}

const scopeReturning = (reply: unknown) =>
  new LogistRegionScopeService({
    send: jest.fn(() =>
      reply instanceof Error ? throwError(() => reply) : of(reply),
    ),
  } as never);

const requesterSent = (search: { send: jest.Mock }) =>
  (search.send.mock.calls[0] as unknown[])[1] as {
    requester: Record<string, unknown>;
  };

const req = (sub: string, roles: string[]) =>
  ({ user: { sub, username: 'u', roles } }) as never;

describe('hGcR8kio — GET /search (gateway)', () => {
  it('logist: requester.region_ids = o‘z viloyatlari', async () => {
    const { controller, search } = setup(
      scopeReturning({ statusCode: 200, data: { region_ids: ['5', '9'] } }),
    );
    await controller.query(
      '+998901234567',
      undefined,
      undefined,
      '1',
      '10',
      req('42', ['logist']),
    );
    expect(requesterSent(search).requester).toEqual({
      id: '42',
      roles: ['logist'],
      region_ids: ['5', '9'],
    });
  });

  it('logist: logistics xatosi yoki xizmat yo‘q — region_ids: [] (fail-closed), qidiruv yiqilmaydi', async () => {
    for (const scope of [scopeReturning(new Error('down')), null]) {
      const { controller, search } = setup(scope);
      const res = await controller.query(
        'Ali',
        undefined,
        undefined,
        undefined,
        undefined,
        req('42', ['logist']),
      );
      expect(res).toBe(searchReply);
      expect(requesterSent(search).requester.region_ids).toEqual([]);
    }
  });

  it('boshqa rollar: region_ids uzatilmaydi, viloyat so‘ralmaydi', async () => {
    const logistics = { send: jest.fn() };
    const scope = new LogistRegionScopeService(logistics as never);
    for (const roles of [['admin'], ['courier'], ['manager'], ['market']]) {
      const { controller, search } = setup(scope);
      await controller.query(
        'x',
        undefined,
        undefined,
        undefined,
        undefined,
        req('1', roles),
      );
      expect(requesterSent(search).requester).not.toHaveProperty('region_ids');
    }
    expect(logistics.send).not.toHaveBeenCalled();
  });
});
