import { SmsOutboxService } from './sms-outbox.service';
import { SmsBlockedError } from './sms-gate.service';

describe('SmsOutboxService promo consent boundary', () => {
  const input = {
    to: '+998901111111',
    customerId: '7',
    text: 'Aksiya',
    messageClass: 'promo' as const,
  };
  const insert = jest.fn().mockResolvedValue({ identifiers: [{ id: '1' }] });
  const partition = jest.fn();
  const gate = {
    assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
    scheduleFor: jest.fn((_: unknown, now: Date) => now),
  };
  const service = new SmsOutboxService(
    { insert } as never,
    {} as never,
    {} as never,
    { provider: 'eskiz', cost: () => null } as never,
    gate as never,
    {
      partition,
      appendOptOut: (text: string) => `${text}\nRad etish: example.test`,
    } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects promo with missing consent before writing any row', async () => {
    partition.mockResolvedValue({ allowed: [], blocked: [input] });
    await expect(service.enqueue([input])).rejects.toMatchObject({
      reason: 'no_consent',
    } as SmsBlockedError);
    expect(insert).not.toHaveBeenCalled();
  });

  it('queues promo only after consent passes', async () => {
    partition.mockResolvedValue({ allowed: [input], blocked: [] });
    const result = await service.enqueue([input]);
    expect(partition).toHaveBeenCalledWith(
      [{ phone: input.to, customer_id: '7' }],
      expect.any(Date),
    );
    expect(result.queued).toHaveLength(1);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
