import { of, throwError } from 'rxjs';
import { SearchGatewayController } from './search-gateway.controller';

/**
 * ISeuwhfr — `GET /search`: market operatorining marketi identity'dan
 * olinadi va `requester.market_id` sifatida search-service'ga uzatiladi.
 */
describe('GET /search — market operatori (ISeuwhfr)', () => {
  const build = (identity: { send: jest.Mock }) => {
    const searchClient = {
      send: jest.fn(() => of({ success: true, data: { items: [] } })),
    };
    const controller = new SearchGatewayController(
      searchClient as any,
      identity as any,
    );
    return { controller, searchClient };
  };
  const req = (roles: string[]) => ({
    user: { sub: '77', username: 'op', roles },
  });
  const requesterOf = (searchClient: { send: jest.Mock }) =>
    searchClient.send.mock.calls[0][1].requester;

  it('⭐ operator: market_id identity `user.market_id` dan', async () => {
    const identity = {
      send: jest.fn(() => of({ data: { id: '77', market_id: '7' } })),
    };
    const { controller, searchClient } = build(identity);

    await controller.query(
      'tel',
      undefined,
      undefined,
      '1',
      '10',
      req(['market_operator']),
    );

    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '77' },
    );
    expect(requesterOf(searchClient)).toEqual({
      id: '77',
      roles: ['market_operator'],
      market_id: '7',
    });
  });

  it('biriktirilmagan yoki identity javob bermasa — market_id bo‘sh (buyurtmasiz qidiruv)', async () => {
    for (const identity of [
      { send: jest.fn(() => of({ data: { id: '77', market_id: null } })) },
      { send: jest.fn(() => throwError(() => new Error('timeout'))) },
    ]) {
      const { controller, searchClient } = build(identity);
      await controller.query(
        'tel',
        undefined,
        undefined,
        undefined,
        undefined,
        req(['market_operator']),
      );
      expect(requesterOf(searchClient).market_id).toBe('');
    }
  });

  it('boshqa rollar uchun identity so‘ralmaydi va market_id uzatilmaydi', async () => {
    for (const roles of [['market'], ['courier'], ['admin'], ['superadmin']]) {
      const identity = { send: jest.fn() };
      const { controller, searchClient } = build(identity);
      await controller.query(
        'x',
        undefined,
        undefined,
        undefined,
        undefined,
        req(roles),
      );
      expect(identity.send).not.toHaveBeenCalled();
      expect(requesterOf(searchClient)).not.toHaveProperty('market_id');
    }
  });
});
