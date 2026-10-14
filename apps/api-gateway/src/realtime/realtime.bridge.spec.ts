import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { of } from 'rxjs';
import { NotificationInboxService } from '../../../notification-service/src/notification-inbox.service';
import { RealtimeController } from './realtime.controller';
import { RealtimeGateway } from './realtime.gateway';

/**
 * m9BOlEbE (backend TC) — REALTIME kanali UCHIDAN-UCHIGA: notification-service
 * dispatch → gateway navbatiga `realtime.notify` emit → RealtimeController →
 * socket.io xonasi (`user:<id>` / `role:<rol>`) → `notification:new`.
 * Frontend mijozi (socket.io-client) shu kontraktga ulanadi — FRONTEND_CHANGELOG.
 */
describe('m9BOlEbE — realtime ko‘prigi (dispatch → gateway → socket)', () => {
  const SECRET = 'realtime-test-secret';
  let roomEmits: Array<{ room: string | null; event: string; data: unknown }>;
  let gateway: RealtimeGateway;
  let controller: RealtimeController;
  const context = {
    getChannelRef: () => ({ ack: jest.fn() }),
    getMessage: () => ({}),
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    roomEmits = [];
    gateway = new RealtimeGateway(new JwtService({ secret: SECRET }));
    (gateway as unknown as { server: unknown }).server = {
      to: (room: string) => ({
        emit: (event: string, data: unknown) =>
          roomEmits.push({ room, event, data }),
      }),
      emit: (event: string, data: unknown) =>
        roomEmits.push({ room: null, event, data }),
    };
    controller = new RealtimeController(gateway);
  });

  /** notification-service'ning GATEWAY klienti — emit'ni controller'ga uzatadi. */
  const bridgeClient = () => ({
    emit: jest.fn((pattern: { cmd: string }, message: unknown) => {
      expect(pattern).toEqual({ cmd: 'realtime.notify' });
      controller.notify(message as never, context as never);
      return of(null);
    }),
  });

  const inbox = (gatewayClient: { emit: jest.Mock }) => {
    let nextId = 500;
    const store = new Map<string, Record<string, unknown>>();
    const txRepo = {
      create: (v: Record<string, unknown>) => ({ ...v }),
      insert: (rows: Array<Record<string, unknown>>) =>
        Promise.resolve({
          identifiers: rows.map((row) => {
            const id = String(nextId++);
            store.set(id, { id, ...row, createdAt: new Date() });
            return { id };
          }),
        }),
      find: ({ where }: { where: { id: { value: string[] } } }) =>
        Promise.resolve((where.id?.value ?? []).map((id) => store.get(id))),
    };
    const manager = { getRepository: () => txRepo };
    return new NotificationInboxService(
      {
        manager: {
          transaction: (work: (m: unknown) => Promise<unknown>) =>
            work(manager),
        },
        createQueryBuilder: () => {
          const qb: Record<string, jest.Mock> = {};
          for (const key of ['update', 'set', 'setParameter', 'whereInIds'])
            qb[key] = jest.fn(() => qb);
          qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
          return qb;
        },
      } as never,
      { send: jest.fn() } as never,
      gatewayClient as never,
      { sendNotification: jest.fn() } as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { enqueue: jest.fn() } as never,
      { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
    );
  };

  it('aniq qabul qiluvchi: `user:<id>` xonasiga `notification:new` — to‘liq qator (id bilan), delivery.realtime = emitted', async () => {
    const client = bridgeClient();
    const res = (await inbox(client).dispatch({
      recipient_id: '42',
      type: 'order.sold',
      title: 'Sotildi',
      channels: ['in_app', 'realtime'],
    } as never)) as { data: { by_channel: Record<string, number> } };
    expect(client.emit).toHaveBeenCalledTimes(1);
    expect(roomEmits).toEqual([
      {
        room: 'user:42',
        event: 'notification:new',
        data: expect.objectContaining({
          id: '500',
          recipient_id: '42',
          type: 'order.sold',
          title: 'Sotildi',
          is_read: false,
        }),
      },
    ]);
    expect(res.data.by_channel.realtime).toBe(1);
  });

  it('rol bo‘yicha: BITTA `role:<rol>` signali (qator id’siz) — frontend inboxni qayta so‘raydi', async () => {
    const service = inbox(bridgeClient());
    jest
      .spyOn(
        service as unknown as { resolveRecipients: () => unknown },
        'resolveRecipients',
      )
      .mockResolvedValue([
        { id: '1', role: 'courier', via: 'identity' },
        { id: '2', role: 'courier', via: 'identity' },
      ]);
    await service.dispatch({
      roles: ['courier'],
      type: 'system.manual',
      title: 'E’lon',
      channels: ['in_app', 'realtime'],
    } as never);
    expect(roomEmits).toEqual([
      {
        room: 'role:courier',
        event: 'notification:new',
        data: { type: 'system.manual', category: 'system', priority: 'normal' },
      },
    ]);
  });

  it('socket ulanishi JWT bilan: to‘g‘ri token → `user:` va `role:` xonalari; yo‘q/soxta → uziladi', () => {
    const token = new JwtService({ secret: SECRET }).sign({
      sub: '42',
      roles: ['COURIER'],
    });
    const joined: string[] = [];
    const ok = {
      id: 's1',
      data: {},
      handshake: { auth: { token }, headers: {} },
      join: (room: string) => joined.push(room),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    gateway.handleConnection(ok as never);
    expect(joined).toEqual(['user:42', 'role:courier']);
    expect(ok.emit).toHaveBeenCalledWith('connected', {
      user_id: '42',
      roles: ['courier'],
    });
    expect(gateway.isOnline('42')).toBe(true);

    const bad = {
      id: 's2',
      data: {},
      handshake: { auth: { token: `${token}x` }, headers: {} },
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    gateway.handleConnection(bad as never);
    expect(bad.disconnect).toHaveBeenCalledWith(true);
    expect(bad.join).not.toHaveBeenCalled();
  });
});
