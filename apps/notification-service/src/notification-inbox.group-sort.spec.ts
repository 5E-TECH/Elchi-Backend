import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { DataSource, In } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Notification } from './entities/notification.entity';
import { NotificationInboxService } from './notification-inbox.service';

/**
 * inbox-group-sort (OA16fdSq / QFoRULeu topilmasi, 2026-10-09 prod UI testi):
 * `group_key` bo'yicha mavjud qator yangilanganda (`order:{id}:status` —
 * yaratildi → qabul qilindi → yo'lda → bekor) qatorning `createdAt` i
 * o'zgarmasdi, shuning uchun #36 "bekor qilindi" (14:41) qatori 14:26 vaqti
 * bilan ro'yxat PASTIDA qolib ketardi — foydalanuvchi yangi holatni ko'rmasdi.
 *
 * Endi: guruh yangilanishi — yangi hodisa: `createdAt` DB soati bilan
 * (`CURRENT_TIMESTAMP`) yangilanadi, qator tepaga chiqadi; `is_read` qayta
 * `false`, sanoqlar to'g'ri, sahifalash `createdAt DESC, id DESC` bilan
 * barqaror. So'rovlar soni o'zgarmaydi (QFoRULeu/uFmUS86e: bulk INSERT,
 * bitta UPDATE).
 *
 * Xotiradagi jadval Postgres xulqini takrorlaydi: INSERT — `DEFAULT now()`,
 * UPDATE dagi `() => 'CURRENT_TIMESTAMP'` — joriy "DB soati", `updatedAt`
 * har UPDATE/save da yangilanadi, `findAndCount` — `order`/`skip`/`take` ni
 * hurmat qiladi (tartib kalitlari bo'lmasa — qo'shilish tartibi).
 */
describe('NotificationInboxService — group_key yangilanganda qator inbox tepasiga chiqadi (inbox-group-sort)', () => {
  let service: NotificationInboxService;
  let store: Map<string, any>;
  let txRepo: any;
  let repo: any;
  let gatewayClient: { emit: jest.Mock };
  /** "DB soati" — tranzaksiya boshidagi `now()` / `CURRENT_TIMESTAMP`. */
  let dbNow: number;

  const MARKET = '37';
  const OPERATOR = '9';

  const at = (iso: string) => {
    dbNow = Date.parse(iso);
  };

  const valuesOf = (operator: any): string[] =>
    (operator?.value ?? (Array.isArray(operator) ? operator : [operator])).map(
      String,
    );

  /** UPDATE dagi SQL ifodasi (`() => '...'`) — faqat CURRENT_TIMESTAMP. */
  const sqlValue = (value: unknown) => {
    if (typeof value !== 'function') return value;
    const expression = (value as () => string)();
    if (expression === 'CURRENT_TIMESTAMP') return new Date(dbNow);
    throw new Error(`mock: qo'llab-quvvatlanmagan SQL ifoda: ${expression}`);
  };

  const matches = (row: any, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, expected]) => {
      if (expected === undefined) return true;
      const actual = row[key];
      if (expected && typeof expected === 'object' && 'value' in expected) {
        return valuesOf(expected).includes(String(actual));
      }
      return String(actual) === String(expected as string | number | boolean);
    });

  const compare = (a: any, b: any, key: string) => {
    if (key === 'id') {
      const diff = BigInt(a.id) - BigInt(b.id);
      return diff === 0n ? 0 : diff > 0n ? 1 : -1;
    }
    const left = a[key] instanceof Date ? a[key].getTime() : a[key];
    const right = b[key] instanceof Date ? b[key].getTime() : b[key];
    return left === right ? 0 : left > right ? 1 : -1;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store = new Map();
    let nextId = 1;
    at('2026-10-09T14:26:00.000Z');

    txRepo = {
      create: jest.fn((value: any) => ({ ...value })),
      insert: jest.fn((rows: any[]) =>
        Promise.resolve({
          identifiers: rows.map((row) => {
            const id = String(nextId++);
            store.set(id, {
              id,
              isDeleted: false,
              // DEFAULT now()
              createdAt: new Date(dbNow),
              updatedAt: new Date(dbNow),
              ...row,
            });
            return { id };
          }),
        }),
      ),
      update: jest.fn((where: any, patch: any) => {
        const ids = valuesOf(where.id);
        const applied = Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [key, sqlValue(value)]),
        );
        for (const id of ids) {
          store.set(id, {
            ...store.get(id),
            ...applied,
            // @UpdateDateColumn — TypeORM har UPDATE ga qo'shadi.
            updatedAt: new Date(dbNow),
          });
        }
        return Promise.resolve({ affected: ids.length });
      }),
      find: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...store.values()].filter((row) => matches(row, where)),
        ),
      ),
    };

    const qb: any = {
      update: jest.fn(() => qb),
      set: jest.fn(() => qb),
      setParameter: jest.fn(() => qb),
      whereInIds: jest.fn(() => qb),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    repo = {
      findAndCount: jest.fn(({ where, order, skip, take }: any) => {
        const rows = [...store.values()].filter((row) => matches(row, where));
        const keys: Array<[string, 'ASC' | 'DESC']> = Object.entries(
          order ?? {},
        );
        rows.sort((a, b) => {
          for (const [key, direction] of keys) {
            const result = compare(a, b, key);
            if (result) return direction === 'DESC' ? -result : result;
          }
          return 0;
        });
        const start = skip ?? 0;
        return Promise.resolve([
          rows.slice(start, take ? start + take : undefined),
          rows.length,
        ]);
      }),
      count: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...store.values()].filter((row) => matches(row, where)).length,
        ),
      ),
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...store.values()].find((row) => matches(row, where)) ?? null,
        ),
      ),
      save: jest.fn((row: any) => {
        // save() createdAt ni o'zgartirmaydi, updatedAt — yangilanadi.
        const saved = { ...row, updatedAt: new Date(dbNow) };
        store.set(String(row.id), saved);
        return Promise.resolve(saved);
      }),
      createQueryBuilder: jest.fn(() => qb),
      manager: {
        transaction: jest.fn((work: (manager: any) => Promise<unknown>) =>
          work({ getRepository: () => txRepo }),
        ),
      },
    };
    gatewayClient = { emit: jest.fn(() => of(null)) };
    service = new NotificationInboxService(
      repo,
      { send: jest.fn() } as any,
      gatewayClient as any,
      { sendNotification: jest.fn() } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as any,
      { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  /** order-service outbox'idagidek buyurtma holati bildirishnomasi. */
  const statusEvent = (
    orderId: string,
    type: string,
    title: string,
    recipients: string[] = [MARKET],
    channels: string[] = ['in_app'],
  ) =>
    service.dispatch({
      recipient_ids: recipients,
      type,
      title,
      body: `Buyurtma #EL-1000${orderId} — ${title.toLowerCase()}.`,
      link: `/orders/${orderId}`,
      group_key: `order:${orderId}:status`,
      data: { order_id: orderId },
      channels,
    } as any);

  const inbox = async (
    recipientId: string,
    query: Record<string, unknown> = {},
  ) =>
    (
      (await service.list({
        recipient_id: recipientId,
        ...query,
      } as any)) as any
    ).data;

  it('#36 bekor qilinsa (14:41) — guruh qatori 14:26 da qolmay, ro‘yxat TEPASIGA chiqadi va vaqti oxirgi hodisa vaqti', async () => {
    await statusEvent('36', 'order.created', 'Buyurtma yaratildi');
    at('2026-10-09T14:28:00.000Z');
    await statusEvent('36', 'order.accepted', 'Buyurtma qabul qilindi');
    // Orada boshqa buyurtma bo'yicha bildirishnoma (yangiroq qator).
    at('2026-10-09T14:35:00.000Z');
    await statusEvent('50', 'order.created', 'Buyurtma yaratildi');
    at('2026-10-09T14:41:00.000Z');
    await statusEvent('36', 'order.cancelled', 'Buyurtma bekor qilindi');

    const market = await inbox(MARKET);
    // Guruh — hamon bitta qator (QFoRULeu: dedupe buzilmagan).
    expect(market.meta.total).toBe(2);
    expect(market.items.map((item: any) => item.link)).toEqual([
      '/orders/36',
      '/orders/50',
    ]);
    expect(market.items[0]).toEqual(
      expect.objectContaining({
        type: 'order.cancelled',
        title: 'Buyurtma bekor qilindi',
        is_read: false,
        created_at: new Date('2026-10-09T14:41:00.000Z'),
      }),
    );
  });

  it('o‘qilgan guruh qatori yangilanganda — qayta o‘qilmagan, unread/unread_count/counts bitta qatorni sanaydi', async () => {
    await statusEvent('36', 'order.created', 'Buyurtma yaratildi');
    at('2026-10-09T14:30:00.000Z');
    await statusEvent('50', 'order.created', 'Buyurtma yaratildi');
    const row36 = [...store.values()].find((row) => row.link === '/orders/36');
    const row50 = [...store.values()].find((row) => row.link === '/orders/50');
    await service.markRead(MARKET, row36.id);
    await service.markRead(MARKET, row50.id);
    expect((await service.unreadCount(MARKET)).data.unread).toBe(0);

    at('2026-10-09T14:41:00.000Z');
    await statusEvent('36', 'order.cancelled', 'Buyurtma bekor qilindi');

    const updated = store.get(row36.id);
    expect(updated.is_read).toBe(false);
    expect(updated.read_at).toBeNull();
    expect(updated.createdAt).toEqual(new Date('2026-10-09T14:41:00.000Z'));
    // Yangi qator yaratilmagan — o'sha id yangilangan.
    expect(store.size).toBe(2);

    const market = await inbox(MARKET);
    expect(market.items[0].id).toBe(row36.id);
    expect(market.unread).toBe(1);
    expect((await service.unreadCount(MARKET)).data.unread).toBe(1);
    // "Faqat o'qilmaganlar" filtri ham bitta qatorni beradi.
    const unreadOnly = await inbox(MARKET, { is_read: false });
    expect(unreadOnly.meta.total).toBe(1);
    expect(unreadOnly.items[0].id).toBe(row36.id);

    // O'qilmagan qator yana yangilansa — sanoq 2 bo'lib ketmaydi.
    at('2026-10-09T14:45:00.000Z');
    await statusEvent('36', 'order.returned', 'Buyurtma qaytarildi');
    expect((await service.unreadCount(MARKET)).data.unread).toBe(1);
  });

  it('o‘qildi belgisi qatorni tepaga sakratmaydi (saralash updatedAt bo‘yicha EMAS)', async () => {
    await statusEvent('36', 'order.created', 'Buyurtma yaratildi');
    at('2026-10-09T14:30:00.000Z');
    await statusEvent('50', 'order.created', 'Buyurtma yaratildi');
    at('2026-10-09T14:40:00.000Z');
    const row36 = [...store.values()].find((row) => row.link === '/orders/36');
    await service.markRead(MARKET, row36.id);

    const market = await inbox(MARKET);
    expect(market.items.map((item: any) => item.link)).toEqual([
      '/orders/50',
      '/orders/36',
    ]);
  });

  it('sahifalash barqaror: teng vaqtli qatorlar id DESC bo‘yicha, sahifalar orasida takror/tushib qolish yo‘q', async () => {
    // Bir xil `now()` (masalan, bir tranzaksiya vaqti) — 5 ta alohida buyurtma.
    for (const orderId of ['61', '62', '63', '64', '65']) {
      await statusEvent(orderId, 'order.created', 'Buyurtma yaratildi');
    }

    const page1 = await inbox(MARKET, { page: 1, limit: 2 });
    const page2 = await inbox(MARKET, { page: 2, limit: 2 });
    const page3 = await inbox(MARKET, { page: 3, limit: 2 });
    const links = [...page1.items, ...page2.items, ...page3.items].map(
      (item: any) => item.link,
    );
    expect(links).toEqual([
      '/orders/65',
      '/orders/64',
      '/orders/63',
      '/orders/62',
      '/orders/61',
    ]);
    expect(page1.meta).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ order: { createdAt: 'DESC', id: 'DESC' } }),
    );

    // Eng eski (#61) yangilansa — 1-sahifa boshiga o'tadi, jami o'zgarmaydi.
    at('2026-10-09T15:00:00.000Z');
    await statusEvent('61', 'order.accepted', 'Buyurtma qabul qilindi');
    const after = await inbox(MARKET, { page: 1, limit: 2 });
    expect(after.items.map((item: any) => item.link)).toEqual([
      '/orders/61',
      '/orders/65',
    ]);
    expect(after.meta.total).toBe(5);
  });

  it('so‘rovlar soni o‘zgarmaydi (QFoRULeu/uFmUS86e): mavjud qatorlar BITTA UPDATE da (createdAt = CURRENT_TIMESTAMP), yangilari bulk INSERT da', async () => {
    const recipients = Array.from({ length: 40 }, (_, i) => String(i + 1));
    await statusEvent(
      '36',
      'order.created',
      'Buyurtma yaratildi',
      recipients.slice(0, 20),
    );
    txRepo.insert.mockClear();
    txRepo.update.mockClear();
    txRepo.find.mockClear();

    at('2026-10-09T14:41:00.000Z');
    const res: any = await statusEvent(
      '36',
      'order.cancelled',
      'Buyurtma bekor qilindi',
      recipients,
    );
    expect(res.data.dispatched).toBe(40);

    // group_key qidiruv + qayta o'qish = 2 find; rolsiz (aniq id) — 1 UPDATE; 1 INSERT.
    expect(txRepo.find).toHaveBeenCalledTimes(2);
    expect(txRepo.update).toHaveBeenCalledTimes(1);
    expect(txRepo.insert).toHaveBeenCalledTimes(1);
    expect(txRepo.insert.mock.calls[0][0]).toHaveLength(20);
    const [where, patch] = txRepo.update.mock.calls[0];
    expect(valuesOf(where.id)).toHaveLength(20);
    expect(patch).toEqual(
      expect.objectContaining({ is_read: false, read_at: null }),
    );
    // Ilova soati (`new Date()`) emas — DB soati, INSERT dagi now() bilan bir xil.
    expect(typeof patch.createdAt).toBe('function');
    expect(patch.createdAt()).toBe('CURRENT_TIMESTAMP');

    // Yangilangan va yangi qatorlar — bir xil vaqt (bitta hodisa).
    const times = new Set(
      [...store.values()].map((row) => row.createdAt.getTime()),
    );
    expect(times).toEqual(new Set([Date.parse('2026-10-09T14:41:00.000Z')]));
  });

  it('realtime payload’dagi created_at ham yangilangan vaqt (qayta o‘qilgan qator)', async () => {
    await statusEvent('36', 'order.created', 'Buyurtma yaratildi', [
      MARKET,
      OPERATOR,
    ]);
    gatewayClient.emit.mockClear();
    at('2026-10-09T14:41:00.000Z');
    await statusEvent(
      '36',
      'order.cancelled',
      'Buyurtma bekor qilindi',
      [MARKET, OPERATOR],
      ['in_app', 'realtime'],
    );

    expect(gatewayClient.emit).toHaveBeenCalledTimes(2);
    for (const [, message] of gatewayClient.emit.mock.calls) {
      expect(message.payload).toEqual(
        expect.objectContaining({
          type: 'order.cancelled',
          created_at: new Date('2026-10-09T14:41:00.000Z'),
        }),
      );
    }
  });

  /**
   * Haqiqiy TypeORM (bazasiz, faqat metadata) — mock'dagi kontrakt Postgres
   * SQL'ga to'g'ri aylanadi: `createdAt` UPDATE da o'zgartiriladigan ustun
   * (`@CreateDateColumn` — `update: false` emas) va ORDER BY tie-breaker bilan.
   */
  describe('TypeORM SQL (bazasiz)', () => {
    let dataSource: DataSource;

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        schema: 'notification_schema',
        entities: [Notification],
      });
      await (
        dataSource as unknown as { buildMetadatas(): Promise<void> }
      ).buildMetadatas();
    });

    it('guruh UPDATE: "createdAt" = CURRENT_TIMESTAMP, is_read qayta false', async () => {
      await statusEvent('36', 'order.created', 'Buyurtma yaratildi');
      at('2026-10-09T14:41:00.000Z');
      await statusEvent('36', 'order.cancelled', 'Buyurtma bekor qilindi');
      const [where, patch] = txRepo.update.mock.calls[0];

      const [sql] = dataSource
        .createQueryBuilder()
        .update(Notification)
        .set(patch as QueryDeepPartialEntity<Notification>)
        .where({ id: In(valuesOf(where.id)) })
        .getQueryAndParameters();
      expect(sql).toContain('"createdAt" = CURRENT_TIMESTAMP');
      expect(sql).toContain('"is_read" = $');
      expect(sql).toContain('"read_at" = $');
    });

    it('list: ORDER BY "createdAt" DESC, "id" DESC', async () => {
      await inbox(MARKET, { page: 2, limit: 20 });
      const options = repo.findAndCount.mock.calls[0][0];
      const sql = dataSource
        .getRepository(Notification)
        .createQueryBuilder('Notification')
        .setFindOptions(options)
        .getQuery();
      expect(sql).toContain(
        'ORDER BY "Notification"."createdAt" DESC, "Notification"."id" DESC',
      );
      expect(sql).toContain('LIMIT 20 OFFSET 20');
    });
  });
});
