import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IoAdapter } from '@nestjs/platform-socket.io';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import { lastValueFrom } from 'rxjs';
import WebSocket from 'ws';
import { RequestContextRmqSerializer } from '@app/common';
import { RealtimeController } from './realtime.controller';
import { RealtimeGateway } from './realtime.gateway';
import { gatewayRealtimeConsumerOptions } from './realtime-consumer.options';
import { buildShiftClosedMessage } from '../../../finance-service/src/realtime/finance-realtime.service';

/**
 * rWdLuoP3 (2026-10-25) — gateway realtime iste'molchisi `noAck: false`:
 * handlerlar xabarni o'zi ack qiladi; avtomatik ack (Nest sukuti) bilan qo'lda
 * ack kanalni 406 bilan yopardi va keyingi hodisa ~5 s kechikardi.
 * Haqiqiy RabbitMQ qismi — `REALTIME_RMQ_TEST_URI` berilsa (aks holda skip).
 */
describe('rWdLuoP3 — gateway realtime RMQ iste`molchisi sozlamasi', () => {
  it('noAck: false (qo`lda ack bilan mos), noAssert, durable — mavjud navbat qayta e`lon qilinmaydi', () => {
    const options = gatewayRealtimeConsumerOptions(
      'amqp://u:p@rabbitmq:5672',
      'gateway_queue',
    );
    expect(options.transport).toBe(Transport.RMQ);
    expect(options.options).toMatchObject({
      urls: ['amqp://u:p@rabbitmq:5672'],
      queue: 'gateway_queue',
      noAck: false,
      noAssert: true,
      queueOptions: { durable: true },
    });
  });
});

const rmqUri = process.env.REALTIME_RMQ_TEST_URI;
const describeRmq = rmqUri ? describe : describe.skip;
const NSP = '/realtime';
const SECRET = 'realtime-rmq-ack-secret';

class RawClient {
  readonly events: Array<{ name: string; data: unknown; at: number }> = [];
  private readonly ws: WebSocket;

  constructor(port: number, token: string) {
    this.ws = new WebSocket(
      `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
    );
    this.ws.on('message', (raw: Buffer) => {
      const text = raw.toString('utf8');
      if (text[0] === '0') {
        this.ws.send(`40${NSP},${JSON.stringify({ token })}`);
      } else if (text[0] === '2') {
        this.ws.send('3');
      } else if (text.startsWith(`42${NSP},`)) {
        const [name, data] = JSON.parse(text.slice(NSP.length + 3)) as [
          string,
          unknown,
        ];
        this.events.push({ name, data, at: Date.now() });
      }
    });
  }

  async waitCount(name: string, count: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (this.events.filter((e) => e.name === name).length < count) {
      if (Date.now() > deadline) {
        throw new Error(`timeout: ${name} x${count}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.events.filter((e) => e.name === name);
  }

  terminate(): void {
    this.ws.terminate();
  }
}

describeRmq(
  'rWdLuoP3 — haqiqiy RabbitMQ: ketma-ket realtime hodisalari kechikmaydi',
  () => {
    const queue = `spec_gateway_rt_${randomUUID().slice(0, 8)}`;
    const jwt = new JwtService({
      secret: SECRET,
      signOptions: { expiresIn: '1h' },
    });
    let app: INestApplication;
    let port: number;
    let client: ClientProxy;
    const errors: unknown[] = [];

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((...args: unknown[]) => {
          errors.push(args);
        });
      // Prod'dagidek navbat oldindan bor (`noAssert: true`).
      const connection = await amqp.connect(rmqUri!);
      const channel = await connection.createChannel();
      await channel.assertQueue(queue, { durable: true });
      await connection.close();

      const moduleRef = await Test.createTestingModule({
        controllers: [RealtimeController],
        providers: [RealtimeGateway, { provide: JwtService, useValue: jwt }],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      app.useWebSocketAdapter(new IoAdapter(app));
      app.connectMicroservice(gatewayRealtimeConsumerOptions(rmqUri!, queue));
      await app.startAllMicroservices();
      await app.listen(0, '127.0.0.1');
      port = (app.getHttpServer() as { address(): AddressInfo }).address().port;
      // finance / notification servislarining GATEWAY klienti (RmqModule bilan bir xil).
      client = ClientProxyFactory.create({
        transport: Transport.RMQ,
        options: {
          urls: [rmqUri!],
          queue,
          noAssert: true,
          serializer: new RequestContextRmqSerializer(),
        },
      });
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      await app?.close();
      const connection = await amqp.connect(rmqUri!);
      const channel = await connection.createChannel();
      await channel.deleteQueue(queue);
      await connection.close();
      jest.restoreAllMocks();
    });

    it('bildirishnoma, MAIN smenasi, filial smenasi — har biri ≤ 2 s; kanal yopilmaydi (406 yo`q)', async () => {
      const admin = new RawClient(
        port,
        jwt.sign({ sub: '2', roles: ['admin'] }),
      );
      const manager = new RawClient(
        port,
        jwt.sign({ sub: '25', roles: ['manager'], branch_id: '15' }),
      );
      const other = new RawClient(
        port,
        jwt.sign({ sub: '26', roles: ['manager'], branch_id: '16' }),
      );
      try {
        await Promise.all(
          [admin, manager, other].map((c) => c.waitCount('connected', 1, 3000)),
        );
        const send = (message: object) =>
          lastValueFrom(client.emit({ cmd: 'realtime.notify' }, message), {
            defaultValue: null,
          });

        let sentAt = Date.now();
        await send({
          event: 'notification:new',
          user_id: '2',
          payload: { id: 'n1' },
        });
        await admin.waitCount('notification:new', 1, 2000);

        sentAt = Date.now();
        await send(
          buildShiftClosedMessage(
            { id: '31', cashbox_user_id: '0', opened_by: '2', closed_by: '2' },
            'manual',
          ),
        );
        const [main] = await admin.waitCount('finance.shift.closed', 1, 2000);
        expect(main.at - sentAt).toBeLessThan(2000);

        sentAt = Date.now();
        await send(
          buildShiftClosedMessage(
            {
              id: '44',
              cashbox_user_id: '15',
              opened_by: '25',
              closed_by: null,
            },
            'auto',
          ),
        );
        const [branch] = await manager.waitCount(
          'finance.shift.auto_closed',
          1,
          2000,
        );
        expect(branch.at - sentAt).toBeLessThan(2000);

        expect(other.events.map((e) => e.name)).toEqual(['connected']);
        expect(admin.events.map((e) => e.name)).toEqual([
          'connected',
          'notification:new',
          'finance.shift.closed',
        ]);
        expect(errors).toEqual([]);
      } finally {
        [admin, manager, other].forEach((c) => c.terminate());
      }
    });
  },
);
