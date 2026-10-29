import * as amqplib from 'amqplib';
import { ensureGatewayRealtimeQueue } from './realtime-consumer.options';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Yangi (bo'sh) RabbitMQ'da `gateway_queue` ni hech kim yaratmasdi —
 * iste'molchi ham, mijozlar ham `noAssert: true`. Gateway har ~5 s
 * «NOT_FOUND - no queue 'gateway_queue'» bilan qayta ulanardi.
 *
 * Bu testlar qulflaydi:
 *   1. navbat bor bo'lsa — `assertQueue` CHAQIRILMAYDI (prod navbati boshqa
 *      argumentlar bilan bo'lsa ham 406 PRECONDITION_FAILED bo'lmaydi);
 *   2. faqat 404 NOT_FOUND da — `durable: true` bilan YANGI kanalda yaratiladi
 *      (404 tekshiruv kanalini yopadi);
 *   3. boshqa xato (masalan 403) — yaratishga urinmasdan yuqoriga uzatiladi;
 *   4. ulanish har holda yopiladi.
 */
describe('ensureGatewayRealtimeQueue — navbat yo`q bo`lsa bir marta yaratish', () => {
  const connect = amqplib.connect as unknown as jest.Mock;

  function fakeBroker(checkQueue: jest.Mock) {
    const channels: Array<{
      checkQueue: jest.Mock;
      assertQueue: jest.Mock;
      close: jest.Mock;
      on: jest.Mock;
    }> = [];
    const connection = {
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      createChannel: jest.fn(() => {
        const channel = {
          checkQueue,
          assertQueue: jest.fn().mockResolvedValue({ queue: 'gateway_queue' }),
          close: jest.fn().mockResolvedValue(undefined),
          on: jest.fn(),
        };
        channels.push(channel);
        return Promise.resolve(channel);
      }),
    };
    connect.mockResolvedValue(connection);
    return { connection, channels };
  }

  const notFound = () =>
    Object.assign(
      new Error(
        "Channel closed by server: 404 (NOT-FOUND) with message \"NOT_FOUND - no queue 'gateway_queue' in vhost '/'\"",
      ),
      { code: 404 },
    );

  afterEach(() => jest.clearAllMocks());

  it('navbat bor — tegilmaydi (assertQueue yo`q), ulanish yopiladi', async () => {
    const { connection, channels } = fakeBroker(
      jest.fn().mockResolvedValue({ queue: 'gateway_queue', messageCount: 3 }),
    );

    await expect(
      ensureGatewayRealtimeQueue('amqp://u:p@rabbitmq:5672', 'gateway_queue'),
    ).resolves.toBe('exists');

    expect(connect).toHaveBeenCalledWith(
      'amqp://u:p@rabbitmq:5672',
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(channels).toHaveLength(1);
    expect(channels[0].checkQueue).toHaveBeenCalledWith('gateway_queue');
    expect(channels[0].assertQueue).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('404 NOT_FOUND — yangi kanalda `durable: true` bilan yaratiladi', async () => {
    const { connection, channels } = fakeBroker(
      jest.fn().mockRejectedValue(notFound()),
    );

    await expect(
      ensureGatewayRealtimeQueue('amqp://x', 'gateway_queue'),
    ).resolves.toBe('created');

    expect(channels).toHaveLength(2);
    expect(channels[0].assertQueue).not.toHaveBeenCalled();
    expect(channels[1].assertQueue).toHaveBeenCalledWith('gateway_queue', {
      durable: true,
    });
    // Kanal xatolari ulanishni yiqitmasin — tinglovchi o'rnatilgan.
    expect(channels[0].on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(connection.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('boshqa xato (403) — yaratishga urinmaydi, xato uzatiladi, ulanish yopiladi', async () => {
    const denied = Object.assign(new Error('ACCESS_REFUSED'), { code: 403 });
    const { connection, channels } = fakeBroker(
      jest.fn().mockRejectedValue(denied),
    );

    await expect(
      ensureGatewayRealtimeQueue('amqp://x', 'gateway_queue'),
    ).rejects.toBe(denied);

    expect(channels).toHaveLength(1);
    expect(channels[0].assertQueue).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('broker yetib bo`lmasa — xato uzatiladi (main.ts uni ogohlantirish qiladi)', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    connect.mockRejectedValue(refused);

    await expect(
      ensureGatewayRealtimeQueue('amqp://x', 'gateway_queue'),
    ).rejects.toBe(refused);
  });
});
