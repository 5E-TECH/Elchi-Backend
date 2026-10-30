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
      createChannel: jest.fn(() => Promise.resolve(channel)),
      close: jest.fn().mockResolvedValue(undefined),
    }),
  ),
}));

import { Logger } from '@nestjs/common';
import { RmqService } from './rmq.service';

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
    const env: Record<string, string> = {
      RABBITMQ_URI: 'amqp://127.0.0.1:5672',
      RABBITMQ_NOTIFICATION_BOT_QUEUE: 'notification_bot_queue',
    };
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
});
