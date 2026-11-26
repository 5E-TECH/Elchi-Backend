import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NEVER, of, throwError } from 'rxjs';
import { RealtimeGateway } from './realtime.gateway';
import {
  PRESENCE_FLUSH_TIMEOUT_MS,
  PRESENCE_GRACE_MS,
  PresenceActivityPublisher,
} from './presence-activity.publisher';

/**
 * (pe71yf8L) Market «Online / Offline»: gateway socket holati.
 *
 * - `isPresent` — kamida bitta socket YOKI oxirgi socket uzilganiga
 *   `PRESENCE_GRACE_MS` (45 s) bo'lmagan; `isOnline` (push qarori) —
 *   avvalgidek kutishsiz.
 * - identity `last_seen_at`: haqiqiy offline → online o'tishda (hozir) va
 *   kutish tugagach (uzilish vaqti). Qisqa uzilish (token yangilanishi,
 *   sahifa qayta yuklanishi) — yozuv yo'q, «Online» uzilmaydi.
 */
describe('pe71yf8L — realtime presence (Online / Offline)', () => {
  const jwt = new JwtService({ secret: 'pe71yf8L-presence-secret' });
  let gateway: RealtimeGateway;
  let seen: jest.Mock;
  let flush: jest.Mock;

  const socket = (sub: string, id: string) => {
    const client = {
      id,
      data: {} as Record<string, unknown>,
      disconnected: false,
      handshake: {
        auth: { token: jwt.sign({ sub, roles: ['market'] }) },
        headers: {},
      },
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(() => {
        client.disconnected = true;
      }),
    };
    return client;
  };

  const connect = async (client: ReturnType<typeof socket>) =>
    gateway.handleConnection(client as never);
  const drop = (client: ReturnType<typeof socket>) => {
    client.disconnected = true;
    gateway.handleDisconnect(client as never);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-27T09:00:00.000Z'));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    seen = jest.fn();
    flush = jest.fn().mockResolvedValue(undefined);
    gateway = new RealtimeGateway(jwt, undefined, {
      seen,
      flush,
    } as unknown as PresenceActivityPublisher);
  });

  afterEach(async () => {
    await gateway.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('⭐ TC1/TC2: ulanish → Online va last_seen (hozir); yopilgach 45 s Online, keyin Offline va last_seen = uzilish vaqti', async () => {
    const tab = socket('26', 's1');
    expect(gateway.isPresent('26')).toBe(false);

    await connect(tab);
    expect(gateway.isPresent('26')).toBe(true);
    expect(gateway.isOnline('26')).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith(
      '26',
      new Date('2026-11-27T09:00:00.000Z'),
    );

    await jest.advanceTimersByTimeAsync(10 * 60_000);
    const droppedAt = new Date();
    drop(tab);
    // Push qarori darhol offline; ko'rsatish — kutish davomida Online.
    expect(gateway.isOnline('26')).toBe(false);
    expect(gateway.isPresent('26')).toBe(true);

    await jest.advanceTimersByTimeAsync(PRESENCE_GRACE_MS - 1);
    expect(gateway.isPresent('26')).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(gateway.isPresent('26')).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenLastCalledWith('26', droppedAt);
  });

  it('⭐ qisqa uzilish (token yangilanishi): 45 s ichida qayta ulansa — Online uzilmaydi, identity`ga yozuv yo`q', async () => {
    const first = socket('26', 's1');
    await connect(first);
    seen.mockClear();

    drop(first);
    await jest.advanceTimersByTimeAsync(800);
    await connect(socket('26', 's2'));

    expect(gateway.isPresent('26')).toBe(true);
    await jest.advanceTimersByTimeAsync(PRESENCE_GRACE_MS * 3);
    expect(gateway.isPresent('26')).toBe(true);
    expect(seen).not.toHaveBeenCalled();
  });

  it('⭐ TC3: ikki tab — bittasi yopilsa Online, ikkalasi yopilsa (45 s dan keyin) Offline', async () => {
    const a = socket('26', 'a');
    const b = socket('26', 'b');
    await connect(a);
    await connect(b);
    // Ikkinchi tab offline → online o'tish emas — qo'shimcha yozuv yo'q.
    expect(seen).toHaveBeenCalledTimes(1);

    drop(a);
    await jest.advanceTimersByTimeAsync(PRESENCE_GRACE_MS * 2);
    expect(gateway.isPresent('26')).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);

    drop(b);
    await jest.advanceTimersByTimeAsync(PRESENCE_GRACE_MS);
    expect(gateway.isPresent('26')).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('foydalanuvchilar bir-biriga ta`sir qilmaydi; hech ulanmagan — Offline', async () => {
    await connect(socket('26', 's1'));
    expect(gateway.isPresent('26')).toBe(true);
    expect(gateway.isPresent('27')).toBe(false);
    expect(gateway.isPresent(26)).toBe(true);
  });

  it('rad etilgan (tokensiz) socket — online emas, yozuv yo`q', async () => {
    const bad = socket('26', 's1');
    bad.handshake.auth = { token: '' };
    await connect(bad);
    gateway.handleDisconnect(bad as never);
    await jest.advanceTimersByTimeAsync(PRESENCE_GRACE_MS * 2);
    expect(gateway.isPresent('26')).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });

  it('⭐ modul yopilganda (deploy): kutilayotgan uzilish — uzilish vaqti bilan, hali ulangan — hozir; yozuvlar kutiladi, keyingi uzilishlar taymer qo`ymaydi', async () => {
    const left = socket('26', 's1');
    const stays = socket('27', 's2');
    await connect(left);
    await connect(stays);
    seen.mockClear();

    const droppedAt = new Date();
    drop(left);
    await jest.advanceTimersByTimeAsync(10_000);
    const closedAt = new Date();
    let flushed = false;
    flush.mockImplementation(async () => {
      await Promise.resolve();
      flushed = true;
    });
    await gateway.onModuleDestroy();
    expect(flushed).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([
      { userId: '26', at: droppedAt },
      { userId: '27', at: closedAt },
    ]);

    // Server socketlarni yopadi — yangi kutish taymeri yo'q, takroriy yozuv yo'q.
    drop(stays);
    await jest.advanceTimersByTimeAsync(PRESENCE_GRACE_MS * 2);
    expect(seen).not.toHaveBeenCalled();
    expect(gateway.isPresent('26')).toBe(false);
    expect(gateway.isPresent('27')).toBe(false);
    flush.mockClear();
  });

  it('modul yopilganda hech kim yo`q — flush chaqirilmaydi', async () => {
    await gateway.onModuleDestroy();
    expect(flush).not.toHaveBeenCalled();
  });

  it('publisher yo`q (eski spec`lar kabi) — faqat xotiradagi holat, xato yo`q', async () => {
    const plain = new RealtimeGateway(jwt);
    const tab = socket('26', 's1');
    await plain.handleConnection(tab as never);
    expect(plain.isPresent('26')).toBe(true);
    tab.disconnected = true;
    plain.handleDisconnect(tab as never);
    await jest.advanceTimersByTimeAsync(PRESENCE_GRACE_MS);
    expect(plain.isPresent('26')).toBe(false);
    await expect(plain.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('pe71yf8L — PresenceActivityPublisher', () => {
  it('identity.user.activity.seen ga {user_id, at ISO} yuboradi (kutmaydi)', () => {
    const send = jest.fn(() => of({ recorded: true }));
    const publisher = new PresenceActivityPublisher({ send } as never);
    publisher.seen('26', new Date('2026-11-27T09:00:00.000Z'));
    expect(send).toHaveBeenCalledWith(
      { cmd: 'identity.user.activity.seen' },
      { user_id: '26', at: '2026-11-27T09:00:00.000Z' },
    );
  });

  it('identity xatosi — faqat ogohlantirish logi, otilmaydi', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const send = jest.fn(() => throwError(() => new Error('rmq down')));
    const publisher = new PresenceActivityPublisher({ send } as never);
    expect(() => publisher.seen('26', new Date())).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rmq down'));
    warn.mockRestore();
  });

  it('flush — hammasini yuboradi va javobni kutadi; xato yoki javobsizlik (3 s) yopilishni to`xtatmaydi', async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const send = jest
      .fn()
      .mockReturnValueOnce(of({ recorded: true }))
      .mockReturnValueOnce(throwError(() => new Error('rmq down')))
      .mockReturnValueOnce(NEVER);
    const publisher = new PresenceActivityPublisher({ send } as never);
    let done = false;
    const flushing = publisher
      .flush([
        { userId: '26', at: new Date('2026-11-27T09:00:00.000Z') },
        { userId: '27', at: new Date('2026-11-27T09:01:00.000Z') },
        { userId: '28', at: new Date('2026-11-27T09:02:00.000Z') },
      ])
      .then(() => {
        done = true;
      });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenNthCalledWith(
      3,
      { cmd: 'identity.user.activity.seen' },
      { user_id: '28', at: '2026-11-27T09:02:00.000Z' },
    );
    await jest.advanceTimersByTimeAsync(PRESENCE_FLUSH_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await flushing;
    expect(done).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    jest.useRealTimers();
  });
});
