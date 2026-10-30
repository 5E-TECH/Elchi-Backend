const assertQueue = jest.fn().mockResolvedValue(undefined);
const channel = {
  on: jest.fn(),
  assertExchange: jest.fn().mockResolvedValue(undefined),
  assertQueue,
  bindQueue: jest.fn().mockResolvedValue(undefined),
  checkQueue: jest.fn().mockRejectedValue(new Error('NOT_FOUND')),
  close: jest.fn().mockResolvedValue(undefined),
};
jest.mock('amqplib', () => ({
  connect: jest.fn(() =>
    Promise.resolve({
      on: jest.fn(),
      createChannel: jest.fn(() => Promise.resolve(channel)),
      close: jest.fn().mockResolvedValue(undefined),
    }),
  ),
}));

import { Logger } from '@nestjs/common';
import * as amqplib from 'amqplib';
import { RMQ_BOOTSTRAP_CONNECT_TIMEOUT_MS, RmqService } from './rmq.service';

const env: Record<string, string> = {
  RABBITMQ_URI: 'amqp://127.0.0.1:5672',
  RABBITMQ_NOTIFICATION_BOT_QUEUE: 'notification_bot_queue',
};
const connectMock = amqplib.connect as unknown as jest.Mock;

/**
 * BOT-3a (#592 ko'rib chiqish) — publisher navbatni o'zi e'lon qiladi
 * (`ensureQueue`): iste'molchi hali ko'tarilmagan paytda yuborilgan xabar
 * yo'qolmasin. Argumentlar iste'molchi (`getOptions`) bilan AYNI — aks holda
 * PRECONDITION_FAILED (2026-09-14 hodisasi).
 */
describe('RmqService.ensureQueue (BOT-3a)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    assertQueue.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ main navbat iste`molchi bilan AYNI argumentlar bilan e`lon qilinadi (+ DLQ topologiyasi)', async () => {
    const service = new RmqService({ get: (key: string) => env[key] } as never);
    await service.ensureQueue('NOTIFICATION_BOT');

    const consumer = service.getOptions('NOTIFICATION_BOT') as {
      options: { queue: string; queueOptions: Record<string, unknown> };
    };
    expect(assertQueue).toHaveBeenCalledWith('notification_bot_queue_dlq', {
      durable: true,
    });
    expect(assertQueue).toHaveBeenCalledWith(
      consumer.options.queue,
      consumer.options.queueOptions,
    );
  });

  it('⭐ ulanish handshake chegarasi bilan va `error` tinglovchisi bilan ochiladi', async () => {
    connectMock.mockClear();
    const service = new RmqService({ get: (key: string) => env[key] } as never);
    await service.ensureQueue('NOTIFICATION_BOT');
    expect(connectMock).toHaveBeenCalled();
    for (const [, options] of connectMock.mock.calls as Array<
      [string, { timeout?: number }]
    >) {
      expect(options).toEqual({ timeout: RMQ_BOOTSTRAP_CONNECT_TIMEOUT_MS });
    }
    for (const result of connectMock.mock.results as Array<{
      value: Promise<{ on: jest.Mock }>;
    }>) {
      const connection = await result.value;
      expect(connection.on).toHaveBeenCalledWith('error', expect.any(Function));
    }
  });

  it('⭐ osilgan broker listen`ni TO`SMAYDI: umumiy chegara — faqat warn, xato otilmaydi', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    connectMock.mockImplementationOnce(() => new Promise(() => undefined));
    const service = new RmqService({ get: (key: string) => env[key] } as never);
    await expect(
      service.ensureQueue('NOTIFICATION_BOT', 50),
    ).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain('notification_bot_queue');
  });

  it('broker xatosi (CONNECTION_FORCED) — faqat warn', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    connectMock.mockRejectedValueOnce(new Error('CONNECTION_FORCED'));
    const service = new RmqService({ get: (key: string) => env[key] } as never);
    await expect(
      service.ensureQueue('NOTIFICATION_BOT'),
    ).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain('CONNECTION_FORCED');
  });
});
