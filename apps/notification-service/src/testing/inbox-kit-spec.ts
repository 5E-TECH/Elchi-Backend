/**
 * NotificationInboxService uchun xotiradagi harness (rzGKtE9N / TgYRqaTk /
 * VICfJuoi / 2crjWf7v spec'lari). Fayl nomi `*-spec.ts` — jest uni test deb
 * yugurtirmaydi, build esa chiqarib tashlaydi.
 */
import { of } from 'rxjs';
import { NotificationInboxService } from '../notification-inbox.service';
import type { DispatchDedupService } from '../dedup/dispatch-dedup.service';
import type { TelegramDmService } from '../telegram/telegram-dm.service';

export type StoredRow = Record<string, unknown> & {
  id: string;
  recipient_id: string;
  delivery?: Record<string, string>;
};

/** Xotiradagi dedup: `seen` / `claim` — tranzaksiya ichidagi INSERT … ON CONFLICT o'rnida. */
export function makeMemoryDedup() {
  const keys = new Set<string>();
  return {
    keys,
    seen: jest.fn((key: string) => Promise.resolve(keys.has(key))),
    claim: jest.fn((_manager: unknown, key: string) => {
      if (keys.has(key)) return Promise.resolve(false);
      keys.add(key);
      return Promise.resolve(true);
    }),
  };
}

export function makeInbox(
  options: {
    dm?: object | null;
    dedup?: object | null;
    telegramService?: { sendNotification: jest.Mock };
    /** (vNKGbg5q) `roles` nishoni uchun identity (`identity.audience.resolve`). */
    identityClient?: { send: jest.Mock };
  } = {},
) {
  let nextId = 1;
  const store = new Map<string, StoredRow>();
  const txRepo = {
    create: jest.fn((v: Record<string, unknown>) => ({ ...v })),
    insert: jest.fn((rows: Array<Record<string, unknown>>) =>
      Promise.resolve({
        identifiers: rows.map((row) => {
          const id = String(nextId++);
          store.set(id, { id, ...row } as StoredRow);
          return { id };
        }),
      }),
    ),
    find: jest.fn(
      ({
        where,
      }: {
        where: { id?: { value: string[] } } & Record<string, unknown>;
      }) =>
        Promise.resolve(
          where.id?.value
            ? where.id.value.map((id) => store.get(id))
            : // group_key bo'yicha mavjud qatorlar (persistRows dedupe).
              [...store.values()].filter(
                (row) =>
                  row.group_key === where.group_key &&
                  (
                    (where.recipient_id as { value?: string[] } | undefined)
                      ?.value ?? []
                  ).includes(String(row.recipient_id)),
              ),
        ),
    ),
    update: jest.fn(
      (
        criteria: { id: { value: string[] } },
        patch: Record<string, unknown>,
      ) => {
        for (const id of criteria.id.value) {
          const row = store.get(id);
          if (row) store.set(id, { ...row, ...patch } as StoredRow);
        }
        return Promise.resolve({ affected: criteria.id.value.length });
      },
    ),
    count: jest.fn().mockResolvedValue(0),
  };
  const manager = {
    getRepository: () => txRepo,
    // (BOT-3c) relay: tranzaksiyada `delivery.telegram = queued`.
    query: jest.fn((sql: string, params: unknown[] = []) => {
      if (/"telegram":"queued"/.test(sql)) {
        for (const id of (params[0] as string[]) ?? []) {
          const row = store.get(String(id));
          if (row) {
            store.set(String(id), {
              ...row,
              delivery: { ...(row.delivery ?? {}), telegram: 'queued' },
            });
          }
        }
      }
      return Promise.resolve([]);
    }),
  };
  const repo = {
    manager: {
      transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
    },
    createQueryBuilder: () => {
      const qb: Record<string, jest.Mock> = {};
      for (const key of ['update', 'set', 'setParameter', 'whereInIds'])
        qb[key] = jest.fn(() => qb);
      qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
      return qb;
    },
  };
  const telegramService = withGroupRelay(
    options.telegramService ?? {
      sendNotification: jest.fn().mockResolvedValue({
        data: { success: 1, failed: 0, results: [{ ok: true }] },
      }),
    },
  );
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new NotificationInboxService(
    repo as never,
    (options.identityClient ?? { send: jest.fn() }) as never,
    { emit: jest.fn(() => of(null)) } as never,
    telegramService as never,
    activityLog as never,
    { enqueue: jest.fn() } as never,
    { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
    undefined,
    undefined,
    undefined,
    (options.dm ?? undefined) as TelegramDmService | undefined,
    undefined,
    undefined,
    undefined,
    (options.dedup ?? undefined) as DispatchDedupService | undefined,
  );
  return { service, store, txRepo, telegramService, activityLog };
}

/**
 * (BOT-3c) Guruh relay'i endi ikki qadam: dispatch tranzaksiyasi ichida
 * `enqueueGroupRelay` (outbox qatori), commit'dan keyin `flushGroupRelay`.
 * Mavjud spec'lar relay natijasini `sendNotification` mock'i orqali
 * boshqaradi — bu yordamchi ikkala qadamni shu mock'ga ulaydi (yuborilgan
 * payload — avvalgidek `{market_id, group_id, group_type, message, parse_mode}`).
 */
export function withGroupRelay<T extends { sendNotification: jest.Mock }>(
  service: T,
): T & { enqueueGroupRelay: jest.Mock; flushGroupRelay: jest.Mock } {
  const pending = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const enqueueGroupRelay = jest.fn(
    (
      _manager: unknown,
      target: Record<string, unknown>,
      message: string,
      notificationIds: string[],
    ) => {
      seq += 1;
      const id = `relay-${seq}`;
      pending.set(id, {
        market_id: target.market_id,
        group_id: target.group_id,
        group_type: target.group_type,
        message,
        parse_mode: 'HTML',
        notification_ids: notificationIds,
      });
      return Promise.resolve([id]);
    },
  );
  const flushGroupRelay = jest.fn(async (ids: string[]) => {
    const payload = { ...pending.get(ids[0]) };
    delete payload.notification_ids;
    return (await service.sendNotification(payload)) as unknown;
  });
  return Object.assign(service, { enqueueGroupRelay, flushGroupRelay });
}
