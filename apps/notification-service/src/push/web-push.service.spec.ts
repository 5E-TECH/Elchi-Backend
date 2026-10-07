import { Logger } from '@nestjs/common';
import { WebPushService } from './web-push.service';

const sendNotification = jest.fn();
const setVapidDetails = jest.fn();

jest.mock('web-push', () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...args),
  setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
}));

const VAPID = {
  VAPID_PUBLIC_KEY: 'BPUBLIC-key-for-tests',
  VAPID_PRIVATE_KEY: 'private-key-for-tests',
  VAPID_SUBJECT: 'mailto:admin@elchipochta.uz',
};

const sub = (id: string, endpoint = `https://push.example/${id}`) =>
  ({ id, user_id: '42', endpoint, p256dh: 'p', auth: 'a' }) as any;

const payload = {
  id: '1',
  title: 'Yangi buyurtma',
  body: '#EL-100081',
  link: '/orders/1',
  type: 'order.new',
  priority: 'normal',
  tag: 'notification-1',
};

describe('WebPushService', () => {
  let repo: any;

  const build = (env: Record<string, string | undefined>) => {
    const config = { get: jest.fn((key: string) => env[key]) };
    const service = new WebPushService(config as any, repo);
    service.onModuleInit();
    return service;
  };

  beforeEach(() => {
    sendNotification.mockReset();
    setVapidDetails.mockReset();
    repo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
  });

  it('stays up but disabled (with a clear WARN) when VAPID keys are missing', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = build({});

    expect(service.enabled).toBe(false);
    expect(service.publicKey).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('VAPID'));
    expect(await service.sendToSubscriptions([sub('1')], payload)).toEqual({
      sent: 0,
      failed: 0,
      gone: 0,
      error: null,
    });
    expect(sendNotification).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('exposes only the PUBLIC key', () => {
    const service = build(VAPID);
    expect(service.enabled).toBe(true);
    expect(service.publicKey).toBe(VAPID.VAPID_PUBLIC_KEY);
    expect(JSON.stringify(service.publicKey)).not.toContain(
      VAPID.VAPID_PRIVATE_KEY,
    );
    expect(setVapidDetails).toHaveBeenCalledWith(
      VAPID.VAPID_SUBJECT,
      VAPID.VAPID_PUBLIC_KEY,
      VAPID.VAPID_PRIVATE_KEY,
    );
  });

  it('disables push when the VAPID keys are rejected', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    setVapidDetails.mockImplementation(() => {
      throw new Error('Vapid public key should be 65 bytes long when decoded.');
    });
    const service = build(VAPID);
    expect(service.enabled).toBe(false);
    error.mockRestore();
  });

  it('records success, deletes 404/410 subscriptions at once and keeps others with last_error', async () => {
    const service = build(VAPID);
    // web-push WebPushError kabi: Error + statusCode + body.
    const pushError = (statusCode: number, body: string) =>
      Object.assign(new Error(body), { statusCode, body });
    sendNotification.mockImplementation((target: { endpoint: string }) => {
      if (target.endpoint.endsWith('/gone'))
        return Promise.reject(pushError(410, 'expired'));
      if (target.endpoint.endsWith('/missing'))
        return Promise.reject(pushError(404, 'not found'));
      if (target.endpoint.endsWith('/down'))
        return Promise.reject(pushError(500, 'oops'));
      return Promise.resolve({ statusCode: 201 });
    });

    const result = await service.sendToSubscriptions(
      [
        sub('1'),
        sub('2', 'https://push.example/gone'),
        sub('3', 'https://push.example/missing'),
        sub('4', 'https://push.example/down'),
      ],
      payload,
    );

    expect(result).toEqual({
      sent: 1,
      gone: 2,
      failed: 1,
      error: 'HTTP 500: oops',
    });
    expect(repo.update).toHaveBeenCalledWith(
      { id: expect.objectContaining({ value: ['1'] }) },
      { last_used_at: expect.any(Date), last_error: null },
    );
    expect(repo.delete).toHaveBeenCalledWith({
      id: expect.objectContaining({ value: ['2', '3'] }),
    });
    expect(repo.update).toHaveBeenCalledWith(
      { id: '4' },
      { last_error: 'HTTP 500: oops' },
    );
  });

  it('sends the payload with TTL/urgency/timeout and marks high & critical as urgent', async () => {
    const service = build(VAPID);
    sendNotification.mockResolvedValue({ statusCode: 201 });

    await service.sendToSubscriptions([sub('1')], {
      ...payload,
      priority: 'critical',
    });

    const [target, body, options] = sendNotification.mock.calls[0];
    expect(target).toEqual({
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(JSON.parse(body)).toEqual(
      expect.objectContaining({ title: 'Yangi buyurtma', link: '/orders/1' }),
    );
    expect(options).toEqual(
      expect.objectContaining({ TTL: 86400, urgency: 'high', timeout: 5000 }),
    );
  });

  it('sends in parallel batches of 100 (not one by one)', async () => {
    const service = build(VAPID);
    let inFlight = 0;
    let peak = 0;
    sendNotification.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { statusCode: 201 };
    });

    const subs = Array.from({ length: 150 }, (_, i) => sub(String(i + 1)));
    const result = await service.sendToSubscriptions(subs, payload);

    expect(result.sent).toBe(150);
    expect(peak).toBe(100);
  });

  it('sendToUser loads that user’s subscriptions', async () => {
    const service = build(VAPID);
    repo.find.mockResolvedValue([sub('1')]);
    sendNotification.mockResolvedValue({ statusCode: 201 });

    const result = await service.sendToUser('42', payload);

    expect(repo.find).toHaveBeenCalledWith({ where: { user_id: '42' } });
    expect(result.sent).toBe(1);
  });
});
