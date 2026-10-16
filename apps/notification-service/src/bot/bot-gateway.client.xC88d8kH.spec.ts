import { BotGatewayClient } from './bot-gateway.client';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: (...args: unknown[]) => rmqSendMock(...args) };
});

/**
 * xC88d8kH #3 — bot aktor nomidan MAVJUD gateway endpointlarini chaqiradi:
 * token identity'dan (`identity.auth.telegram_actor`), faqat Authorization
 * sarlavhasida (URL'da emas), keshlanadi, 401 da tashlanadi.
 */
describe('xC88d8kH — BotGatewayClient', () => {
  const make = () => {
    const client = new BotGatewayClient({} as never, {
      get: () => 'http://api-gateway:3004/',
    } as never);
    const fetchMock = jest.fn((_url: string, _init: RequestInit) =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      } as unknown as Response),
    );
    client.fetchImpl = fetchMock;
    client.now = () => 1_000_000;
    return { client, fetchMock };
  };

  beforeEach(() => {
    rmqSendMock.mockReset().mockResolvedValue({
      accessToken: 'actor.jwt.token',
      access_token_expires_at: 1_000_000 + 30 * 60_000,
    });
  });

  it('⭐ aktor tokeni bilan mavjud endpoint; token faqat Authorization sarlavhasida', async () => {
    const { client, fetchMock } = make();
    const res = await client.request('5550007', 'GET', '/orders?page=1');
    expect(rmqSendMock).toHaveBeenCalledWith(
      {},
      { cmd: 'identity.auth.telegram_actor' },
      { telegram_id: '5550007' },
      expect.any(Object),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api-gateway:3004/orders?page=1');
    expect(url).not.toContain('actor.jwt.token');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer actor.jwt.token',
    );
    expect(res).toEqual({ status: 200, body: { data: [] } });
  });

  it('token keshlanadi; 401 da tashlanadi va keyingi so‘rovda yangisi olinadi', async () => {
    const { client, fetchMock } = make();
    await client.request('5550007', 'GET', '/orders');
    await client.request('5550007', 'GET', '/orders');
    expect(rmqSendMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce({
      status: 401,
      json: () => Promise.resolve({ message: 'Unauthorized' }),
    } as unknown as Response);
    await client.request('5550007', 'GET', '/orders');
    await client.request('5550007', 'GET', '/orders');
    expect(rmqSendMock).toHaveBeenCalledTimes(2);
  });

  it('bog‘lanmagan aktor (identity 401) — so‘rov yuborilmaydi', async () => {
    const { client, fetchMock } = make();
    rmqSendMock.mockRejectedValueOnce({ statusCode: 401, message: 'bog‘lanmagan' });
    await expect(client.request('1', 'GET', '/orders')).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
