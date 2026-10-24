import { NEVER, of, throwError } from 'rxjs';
import {
  SESSIONS_KICK_CHUNK,
  SESSIONS_KICK_PATTERN,
  SessionKickPublisher,
} from './session-kick.publisher';

/**
 * (Elchi Pochta #3, 2026-10-24) identity → gateway `auth.sessions.kick`:
 * gateway so'rov yo'lidan tashqarida (`security_reset`) yopilgan sessiyalar
 * gateway navbatiga e'lon qilinadi — gateway ularning socketlarini uzadi.
 * Fire-and-forget: navbat sozlanmagan / broker xatosi chaqiruvchini
 * to'xtatmaydi.
 */
const SID_A = '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d';
const SID_B = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

const build = (emit: jest.Mock = jest.fn(() => of(null))) => {
  const publisher = new SessionKickPublisher(
    { emit } as never,
    {
      get: (key: string) =>
        key === 'RABBITMQ_GATEWAY_QUEUE' ? 'gateway_queue' : undefined,
    } as never,
  );
  const warn = jest
    .spyOn(
      (publisher as unknown as { logger: { warn: (m: string) => void } })
        .logger,
      'warn',
    )
    .mockImplementation(() => undefined);
  return { publisher, emit, warn };
};

describe('SessionKickPublisher (Elchi Pochta #3, 2026-10-24)', () => {
  it('⭐ gateway navbatiga `auth.sessions.kick` { session_ids, reason } — kichik harf, takrorsiz', async () => {
    const { publisher, emit } = build();
    await publisher.send([SID_A.toUpperCase(), SID_A, SID_B], 'security_reset');
    expect(SESSIONS_KICK_PATTERN).toEqual({ cmd: 'auth.sessions.kick' });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(SESSIONS_KICK_PATTERN, {
      session_ids: [SID_A, SID_B],
      reason: 'security_reset',
    });
  });

  it('ko‘p id — bo‘laklab (≤ 500 tadan)', async () => {
    const { publisher, emit } = build();
    const ids = Array.from(
      { length: SESSIONS_KICK_CHUNK + 3 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    await publisher.send(ids, 'security_reset');
    expect(emit).toHaveBeenCalledTimes(2);
    const sizes = (
      emit.mock.calls as Array<[unknown, { session_ids: string[] }]>
    ).map(([, payload]) => payload.session_ids.length);
    expect(sizes).toEqual([SESSIONS_KICK_CHUNK, 3]);
  });

  it('RABBITMQ_GATEWAY_QUEUE sozlanmagan / bo‘sh — e’lon yo‘q', async () => {
    for (const queue of [undefined, '', '  ']) {
      const emit = jest.fn(() => of(null));
      const publisher = new SessionKickPublisher(
        { emit } as never,
        { get: () => queue } as never,
      );
      await publisher.send([SID_A], 'security_reset');
      publisher.publish([SID_A], 'security_reset');
      expect(emit).not.toHaveBeenCalled();
    }
    const orphan = new SessionKickPublisher(undefined, undefined);
    await expect(
      orphan.send([SID_A], 'security_reset'),
    ).resolves.toBeUndefined();
  });

  it('bo‘sh ro‘yxat — e’lon yo‘q', async () => {
    const { publisher, emit } = build();
    await publisher.send([], 'security_reset');
    expect(emit).not.toHaveBeenCalled();
  });

  it('⭐ broker xatosi — faqat ogohlantirish, chaqiruvchiga chiqmaydi (cron / refresh to‘xtamaydi)', async () => {
    const { publisher, warn } = build(
      jest.fn(() => throwError(() => new Error('channel closed'))),
    );
    await expect(
      publisher.send([SID_A], 'security_reset'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('channel closed'),
    );
    expect(() => publisher.publish([SID_A], 'security_reset')).not.toThrow();
  });

  it('javobsiz broker — 2 s dan keyin voz kechadi', async () => {
    jest.useFakeTimers();
    try {
      const { publisher, warn } = build(jest.fn(() => NEVER));
      const pending = publisher.send([SID_A], 'security_reset');
      await jest.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
