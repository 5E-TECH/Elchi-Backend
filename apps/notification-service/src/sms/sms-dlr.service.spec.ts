import { SmsDlrService } from './sms-dlr.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import { SmsConfigService } from './sms-config.service';

const SECRET = 'd9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0';

describe('SmsDlrService', () => {
  const config = new SmsConfigService({
    get: (key: string) =>
      ({
        SMS_DLR_SECRET: SECRET,
        SMS_DLR_CALLBACK_URL: 'https://api.elchipochta.uz/webhooks/sms',
      })[key],
  } as never);
  const registry = new SmsProviderRegistry(config, {
    onChange: jest.fn(),
  } as never);
  let outbox: { applyDeliveryReport: jest.Mock };
  let service: SmsDlrService;

  beforeEach(() => {
    outbox = { applyDeliveryReport: jest.fn().mockResolvedValue(true) };
    service = new SmsDlrService(registry, outbox as never);
  });

  it('builds a per-message callback URL with our id and a HMAC token', () => {
    const url = new URL(registry.callbackUrl('notif-15')!);
    expect(url.pathname).toBe('/webhooks/sms/eskiz');
    expect(url.searchParams.get('cmid')).toBe('notif-15');
    expect(
      registry.verifyDlrToken('notif-15', url.searchParams.get('token')),
    ).toBe(true);
    expect(
      registry.verifyDlrToken('notif-16', url.searchParams.get('token')),
    ).toBe(false);
  });

  it('a valid DLR is applied by our client_message_id', async () => {
    const token = registry.dlrToken('notif-15');
    const res = await service.handle({
      provider: 'eskiz',
      query: { cmid: 'notif-15', token },
      body: { status: 'DELIVRD' },
    });
    expect(res).toMatchObject({ applied: true, status: 'delivered' });
    expect(outbox.applyDeliveryReport).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMessageId: 'notif-15',
        status: 'delivered',
      }),
    );
  });

  it('a forged/unsigned DLR is rejected (401) and changes nothing', async () => {
    await expect(
      service.handle({
        provider: 'eskiz',
        query: { cmid: 'notif-15', token: 'forged' },
        body: { status: 'DELIVRD' },
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 401 }),
    });
    await expect(
      service.handle({
        provider: 'eskiz',
        query: { cmid: 'notif-15' },
        body: {},
      }),
    ).rejects.toBeDefined();
    expect(outbox.applyDeliveryReport).not.toHaveBeenCalled();
  });
});
