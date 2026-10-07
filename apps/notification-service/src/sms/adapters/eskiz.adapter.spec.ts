import { EskizAdapter } from './eskiz.adapter';
import { SmsProviderError } from '../sms.port';

const json = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

const input = {
  to: '+998901234567',
  text: 'Buyurtma #EL-100081 yetkazildi',
  messageClass: 'transactional' as const,
  clientMessageId: 'notif-15',
  callbackUrl:
    'https://api.elchipochta.uz/webhooks/sms/eskiz?cmid=notif-15&token=t',
};

describe('EskizAdapter', () => {
  const creds = { login: 'ops@elchi.uz', password: 'p', sender: 'ELCHI' };

  it('logs in once, sends with Bearer, Eskiz phone format (998..., no +) and our id + callback', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(json(200, { data: { token: 'tok-1' } }))
      .mockResolvedValueOnce(json(200, { id: 'esk-1', status: 'waiting' }))
      .mockResolvedValueOnce(json(200, { id: 'esk-2', status: 'waiting' }));
    const adapter = new EskizAdapter(
      creds,
      fetchMock as never,
      'https://eskiz.test/api',
    );

    const first = await adapter.send(input);
    await adapter.send({ ...input, clientMessageId: 'notif-16' });

    expect(first.providerMessageId).toBe('esk-1');
    expect(fetchMock).toHaveBeenCalledTimes(3); // login faqat bir marta (token keshi)
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://eskiz.test/api/message/sms/send');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    const body = init.body as URLSearchParams;
    expect(body.get('mobile_phone')).toBe('998901234567');
    expect(body.get('from')).toBe('ELCHI');
    expect(body.get('user_sms_id')).toBe('notif-15');
    expect(body.get('callback_url')).toContain('cmid=notif-15');
  });

  it('an expired token (401) triggers ONE re-login and the send succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(json(200, { data: { token: 'old' } }))
      .mockResolvedValueOnce(json(401, { message: 'Expired' }))
      .mockResolvedValueOnce(json(200, { data: { token: 'new' } }))
      .mockResolvedValueOnce(json(200, { id: 'esk-9' }));
    const adapter = new EskizAdapter(
      creds,
      fetchMock as never,
      'https://eskiz.test/api',
    );

    await expect(adapter.send(input)).resolves.toMatchObject({
      providerMessageId: 'esk-9',
    });
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer new');
  });

  it('5xx and 429 are retryable, 4xx are not', async () => {
    const make = (status: number) =>
      new EskizAdapter(
        creds,
        jest
          .fn()
          .mockResolvedValueOnce(json(200, { data: { token: 't' } }))
          .mockResolvedValueOnce(json(status, { message: 'x' })) as never,
        'https://eskiz.test/api',
      );
    const e500 = await make(503)
      .send(input)
      .catch((e: unknown) => e);
    const e429 = await make(429)
      .send(input)
      .catch((e: unknown) => e);
    const e400 = await make(400)
      .send(input)
      .catch((e: unknown) => e);
    expect(e500).toBeInstanceOf(SmsProviderError);
    expect((e500 as SmsProviderError).retryable).toBe(true);
    expect((e429 as SmsProviderError).retryable).toBe(true);
    expect((e400 as SmsProviderError).retryable).toBe(false);
  });

  it('a network failure is retryable', async () => {
    const adapter = new EskizAdapter(
      creds,
      jest.fn().mockRejectedValue(new Error('ECONNRESET')) as never,
      'https://eskiz.test/api',
    );
    await expect(adapter.send(input)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('DLR is matched by OUR id (cmid) and mapped to one vocabulary', () => {
    const adapter = new EskizAdapter(creds, jest.fn() as never);
    expect(
      adapter.parseDeliveryReport({
        query: { cmid: 'notif-15' },
        body: { status: 'DELIVRD', message_id: 'other-provider-id' },
      }),
    ).toMatchObject({
      clientMessageId: 'notif-15',
      status: 'delivered',
      providerStatus: 'DELIVRD',
    });
    expect(
      adapter.parseDeliveryReport({
        query: { cmid: 'x' },
        body: { status: 'UNDELIV' },
      })?.status,
    ).toBe('not_delivered');
    expect(
      adapter.parseDeliveryReport({ query: {}, body: { status: 'DELIVRD' } }),
    ).toBeNull();
    expect(
      adapter.parseDeliveryReport({
        query: { cmid: 'x' },
        body: { status: '???' },
      }),
    ).toBeNull();
  });

  it('reads the balance', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(json(200, { data: { token: 't' } }))
      .mockResolvedValueOnce(json(200, { data: { balance: 15000 } }));
    await expect(
      new EskizAdapter(creds, fetchMock as never).getBalance(),
    ).resolves.toBe(15000);
  });
});
