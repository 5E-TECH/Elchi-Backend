import { ConfigService } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';
import { RmqModule } from './rmq.module';
import { RMQ_NO_DLX_QUEUES, RmqService, rmqNoDlxProfile } from './rmq.service';

/**
 * be-brief §6.1 — `ai_config_queue`: muhrlangan kalit konverti yuradigan
 * navbat. DLX YO'Q (xabar DLQ'da qolmaydi), TTL 8 s, xabarlar saqlanmaydi
 * (persistent: false), prefetch 4. Mavjud navbatlar o'zgarmaydi.
 */
describe('AI_CONFIG navbati topologiyasi', () => {
  const env: Record<string, string> = {
    RABBITMQ_URI: 'amqp://guest:guest@localhost:5672',
    RABBITMQ_AI_QUEUE: 'ai_queue',
  };
  const service = new RmqService({
    get: (k: string) => env[k],
  } as unknown as ConfigService);

  it('profil: ai_config_queue, TTL 8000, prefetch 4', () => {
    expect(rmqNoDlxProfile('AI_CONFIG')).toEqual({
      defaultName: 'ai_config_queue',
      messageTtl: 8000,
      prefetch: 4,
    });
    expect(rmqNoDlxProfile('AI')).toBeNull();
    expect(rmqNoDlxProfile('__proto__')).toBeNull();
    expect(Object.isFrozen(RMQ_NO_DLX_QUEUES)).toBe(true);
  });

  it('server opsiyalari: x-dead-letter-exchange YO‘Q, persistent false', () => {
    const o = service.getOptions('AI_CONFIG').options as Record<string, any>;
    expect(o.queue).toBe('ai_config_queue');
    expect(o.queueOptions).toEqual({ durable: true, messageTtl: 8000 });
    expect(o.queueOptions).not.toHaveProperty('deadLetterExchange');
    expect(o.queueOptions).not.toHaveProperty('deadLetterRoutingKey');
    expect(o.persistent).toBe(false);
    expect(o.prefetchCount).toBe(4);
  });

  it('tekshiruv argumentlari getOptions bilan bir xil (bitta manba)', () => {
    const args = (
      service as unknown as {
        mainQueueArguments: (id: string) => Record<string, unknown>;
      }
    ).mainQueueArguments('AI_CONFIG');
    expect(args).toEqual({ messageTtl: 8000 });
  });

  it('mavjud AI navbati o‘zgarmagan: DLX bor, persistent true', () => {
    const o = service.getOptions('AI').options as Record<string, any>;
    expect(o.queue).toBe('ai_queue');
    expect(o.queueOptions.deadLetterExchange).toBe('ai_queue_dlx');
    expect(o.persistent).toBe(true);
  });

  it('env nomi ustun turadi', () => {
    const s = new RmqService({
      get: (k: string) =>
        ({ ...env, RABBITMQ_AI_CONFIG_QUEUE: 'ai_config_queue_x' })[k],
    } as unknown as ConfigService);
    expect((s.getOptions('AI_CONFIG').options as any).queue).toBe(
      'ai_config_queue_x',
    );
  });

  it('mijoz (publisher): persistent false, TTL 8000, DLX yo‘q', () => {
    const spy = jest.spyOn(ClientsModule, 'registerAsync');
    let resolved: { options: Record<string, any> };
    try {
      RmqModule.register({ name: 'AI_CONFIG' });
      const [[options]] = spy.mock.calls as unknown as Array<
        [Array<{ useFactory: (c: unknown) => { options: any } }>]
      >;
      resolved = options[0].useFactory({ get: (k: string) => env[k] });
    } finally {
      spy.mockRestore();
    }
    expect(resolved.options.queue).toBe('ai_config_queue');
    expect(resolved.options.persistent).toBe(false);
    expect(resolved.options.queueOptions).toEqual({
      durable: true,
      messageTtl: 8000,
    });
  });
});
