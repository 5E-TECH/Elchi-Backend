import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import WebSocket from 'ws';
import {
  REALTIME_NOTIFY_MAX_TARGETS,
  RealtimeController,
  resolveTargetRooms,
} from './realtime.controller';
import { RealtimeGateway } from './realtime.gateway';
import {
  buildCashboxCardChangedMessage,
  buildShiftClosedMessage,
} from '../../../finance-service/src/realtime/finance-realtime.service';

/**
 * rWdLuoP3 (2026-10-25) — smena / kassa kartasi hodisalari UCHIDAN-UCHIGA:
 * finance `realtime.notify` xabari (`targets`) → RealtimeController →
 * HAQIQIY socket.io serveri (Nest IoAdapter, `/realtime`) → mijozlar.
 * Tekshiriladi: kim oladi, kim OLMAYDI (boshqa filial, boshqa rol), bir
 * nechta xonadagi socket hodisani BIR MARTA oladi.
 */
const SECRET = 'realtime-finance-shift-secret';
const NSP = '/realtime';

/** Minimal socket.io v4 mijozi (`ws` ustida — loyihada socket.io-client yo'q). */
class RawClient {
  readonly events: Array<{ name: string; data: unknown }> = [];
  private readonly ws: WebSocket;
  private waiters: Array<() => void> = [];

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
        this.events.push({ name, data });
        const waiters = this.waiters;
        this.waiters = [];
        waiters.forEach((wake) => wake());
      }
    });
  }

  named(name: string) {
    return this.events.filter((e) => e.name === name);
  }

  async waitFor(name: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.named(name).length) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${name}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  terminate(): void {
    this.ws.terminate();
  }
}

describe('rWdLuoP3 — `realtime.notify` `targets` → xonalar (unit)', () => {
  it('rol → `role:<rol>`; rol + filial → `branch:<id>:role:<rol>`; foydalanuvchi → `user:<id>`; takrorsiz', () => {
    expect(
      resolveTargetRooms([
        { role: 'ADMIN' },
        { role: 'manager', branch_id: 15 },
        { user_id: '25' },
        { user_id: 25 },
        { role: 'admin' },
      ]),
    ).toEqual(['role:admin', 'branch:15:role:manager', 'user:25']);
  });

  it('yaroqsiz nishon tashlanadi: rolsiz filial (butun filial emas), yaroqsiz filial id (hamma filialga KENGAYMAYDI), `:` li id, obyekt', () => {
    expect(
      resolveTargetRooms([
        { branch_id: '15' },
        { role: 'manager', branch_id: '15:role:admin' },
        { role: 'manager', branch_id: { id: 15 } },
        { user_id: 'x:y' },
        { role: 'role:admin' },
        null,
        'admin',
      ]),
    ).toEqual([]);
    expect(resolveTargetRooms(undefined)).toEqual([]);
    expect(resolveTargetRooms({ role: 'admin' })).toEqual([]);
  });

  it(`ko'pi bilan ${REALTIME_NOTIFY_MAX_TARGETS} nishon`, () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      user_id: String(i + 1),
    }));
    expect(resolveTargetRooms(many)).toHaveLength(REALTIME_NOTIFY_MAX_TARGETS);
  });

  it('controller: `targets` — BITTA `pushToRooms`; eski `user_id`/`role` yo`li o`zgarmagan', () => {
    const gateway = {
      pushToRooms: jest.fn(),
      pushToUser: jest.fn(),
      pushToRole: jest.fn(),
      broadcast: jest.fn(),
    };
    const ack = jest.fn();
    const context = { getChannelRef: () => ({ ack }), getMessage: () => ({}) };
    const controller = new RealtimeController(gateway as never);
    const message = buildShiftClosedMessage(
      {
        id: '31',
        cashbox_user_id: '15',
        opened_by: '25',
        closed_by: '25',
        closed_at: '2026-10-25T13:00:00.000Z',
      },
      'manual',
    );
    controller.notify(message as never, context as never);
    expect(gateway.pushToRooms).toHaveBeenCalledTimes(1);
    expect(gateway.pushToRooms).toHaveBeenCalledWith(
      ['branch:15:role:manager', 'user:25'],
      'finance.shift.closed',
      message.payload,
    );
    expect(gateway.pushToUser).not.toHaveBeenCalled();
    expect(gateway.pushToRole).not.toHaveBeenCalled();
    expect(gateway.broadcast).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);

    controller.notify(
      { event: 'notification:new', user_id: '42', payload: { id: 'n' } },
      context as never,
    );
    expect(gateway.pushToUser).toHaveBeenCalledWith('42', 'notification:new', {
      id: 'n',
    });
    expect(gateway.pushToRooms).toHaveBeenCalledTimes(1);
  });
});

describe('rWdLuoP3 — haqiqiy socket.io: smena / karta hodisasi faqat o`z kassasi doirasiga', () => {
  let app: INestApplication;
  let port: number;
  let controller: RealtimeController;
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { expiresIn: '1h' },
  });
  const clients: RawClient[] = [];
  const context = {
    getChannelRef: () => ({ ack: jest.fn() }),
    getMessage: () => ({}),
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [RealtimeGateway, { provide: JwtService, useValue: jwt }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer() as { address(): AddressInfo }).address().port;
    controller = new RealtimeController(app.get(RealtimeGateway));
  });

  afterEach(() => {
    while (clients.length) clients.pop()?.terminate();
  });

  afterAll(async () => {
    if (app) await app.close();
    jest.restoreAllMocks();
  });

  const connect = async (claims: Record<string, unknown>) => {
    const client = new RawClient(port, jwt.sign(claims));
    clients.push(client);
    await client.waitFor('connected');
    return client;
  };

  /** Hodisa yuborilgach "kelmasligi" kerak bo'lganlarni tekshirish uchun — nazorat hodisasi hammaga. */
  const settle = async (all: RawClient[]) => {
    controller.notify(
      { event: 'test:barrier', broadcast: true, payload: {} },
      context as never,
    );
    await Promise.all(all.map((c) => c.waitFor('test:barrier')));
  };

  const users = async () => ({
    superadmin: await connect({ sub: '1', roles: ['SUPERADMIN'] }),
    admin: await connect({ sub: '2', roles: ['admin'], branch_id: null }),
    registrator: await connect({ sub: '3', roles: ['registrator'] }),
    manager15: await connect({
      sub: '25',
      roles: ['manager'],
      branch_id: '15',
    }),
    manager15b: await connect({ sub: '27', roles: ['manager'], branch_id: 15 }),
    manager16: await connect({
      sub: '26',
      roles: ['manager'],
      branch_id: '16',
    }),
    courier15: await connect({
      sub: '40',
      roles: ['courier'],
      branch_id: '15',
    }),
    market: await connect({ sub: '37', roles: ['market'] }),
  });

  it('⭐ FILIAL smenasi yopildi: 15-filial menejerlari oladi (kassir ham bitta xonadan ortiq bo`lsa ham — BIR MARTA); 16-filial menejeri, superadmin/admin/registrator, 15-filial kuryeri, market — OLMAYDI', async () => {
    const u = await users();
    const message = buildShiftClosedMessage(
      {
        id: '44',
        cashbox_user_id: '15',
        opened_by: '25',
        closed_by: '25',
        closed_at: '2026-10-25T13:00:00.000Z',
      },
      'auto',
    );
    controller.notify(message as never, context as never);
    await u.manager15.waitFor('finance.shift.auto_closed');
    await u.manager15b.waitFor('finance.shift.auto_closed');
    await settle(Object.values(u));

    expect(u.manager15.named('finance.shift.auto_closed')).toEqual([
      { name: 'finance.shift.auto_closed', data: message.payload },
    ]);
    expect(u.manager15b.named('finance.shift.auto_closed')).toHaveLength(1);
    expect(
      (
        u.manager15.named('finance.shift.auto_closed')[0].data as {
          closed_at: string;
        }
      ).closed_at,
    ).toBe('2026-10-25T13:00:00.000Z');
    for (const other of [
      u.manager16,
      u.superadmin,
      u.admin,
      u.registrator,
      u.courier15,
      u.market,
    ]) {
      expect(other.named('finance.shift.auto_closed')).toEqual([]);
    }
  });

  it('MAIN smenasi yopildi: superadmin, admin, registrator (har biri BIR MARTA, yopgan admin ham); menejerlar, kuryer, market — OLMAYDI', async () => {
    const u = await users();
    const message = buildShiftClosedMessage(
      {
        id: '31',
        cashbox_user_id: '0',
        opened_by: '3',
        closed_by: '2',
        closed_at: '2026-10-25T14:00:00.000Z',
      },
      'manual',
    );
    controller.notify(message as never, context as never);
    await settle(Object.values(u));

    for (const viewer of [u.superadmin, u.admin, u.registrator]) {
      expect(viewer.named('finance.shift.closed')).toHaveLength(1);
    }
    for (const other of [
      u.manager15,
      u.manager15b,
      u.manager16,
      u.courier15,
      u.market,
    ]) {
      expect(other.named('finance.shift.closed')).toEqual([]);
    }
  });

  it('kassa kartasi o`zgardi: faqat superadmin va admin', async () => {
    const u = await users();
    const message = buildCashboxCardChangedMessage({
      action: 'card_to_cash',
      card_ids: ['3'],
      movement_id: '9',
    });
    controller.notify(message as never, context as never);
    await settle(Object.values(u));

    expect(u.superadmin.named('finance.cashbox.card_changed')).toHaveLength(1);
    expect(u.admin.named('finance.cashbox.card_changed')).toHaveLength(1);
    for (const other of [
      u.registrator,
      u.manager15,
      u.manager16,
      u.courier15,
      u.market,
    ]) {
      expect(other.named('finance.cashbox.card_changed')).toEqual([]);
    }
  });
});
