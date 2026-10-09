import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { TimeoutError, of, throwError } from 'rxjs';
import {
  OutboxEvent,
  OutboxService,
  Order_status,
  Post_status,
  isKnownNotificationType,
} from '@app/common';
import { Post } from '../entities/post.entity';
import { LogisticsServiceService } from '../logistics-service.service';
import {
  BRANCH_STAFF_LOOKUP_TIMEOUT_MS,
  LOGISTICS_NOTIFICATION_TYPES,
  LogisticsNotificationService,
  NOTIFICATION_DISPATCH_PATTERN,
  NOTIFICATION_OUTBOX_TARGET,
  buildBatchArrivedPayload,
} from './logistics-notification.service';

/**
 * ePpLHPX2 — `logistics.batch_arrived`: filiallararo pochta manzil filialga
 * qabul qilindi → filial xodimlariga bildirishnoma (outbox orqali, pochta
 * holati yozuvi bilan bitta tranzaksiyada, fail-open).
 */
const SRC = join(__dirname, '..');

type Row = Record<string, any>;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const STAFF_ROWS = [
  { user_id: '198', role: 'MANAGER' },
  { user_id: '199', role: 'REGISTRATOR' },
  { user_id: '300', role: 'COURIER' }, // kuryer — nishon emas
  { user_id: '198', role: 'MANAGER' }, // takror
  { user_id: null, role: 'MANAGER' },
];

describe('katalog (Eh8y21Ha TC12 analogi)', () => {
  it('logistics yuboradigan tur katalogda', () => {
    expect(LOGISTICS_NOTIFICATION_TYPES).toEqual(['logistics.batch_arrived']);
    LOGISTICS_NOTIFICATION_TYPES.forEach((type) =>
      expect(isKnownNotificationType(type)).toBe(true),
    );
  });
});

describe('buildBatchArrivedPayload', () => {
  it('filial xodimlari qabul qiluvchi; link /mails/{id}; group_key logistics:post:{id}', () => {
    expect(
      buildBatchArrivedPayload({
        post_id: '40',
        branch_id: '10',
        received_count: 3,
        order_count: 4,
        status: Post_status.SENT,
        recipient_ids: ['198', '199', '198', '0', null],
      }),
    ).toEqual({
      type: 'logistics.batch_arrived',
      category: 'logistics',
      priority: 'normal',
      title: 'Pochta filialga yetib keldi',
      body: 'Pochta #40 filialga qabul qilindi: 3 ta buyurtma.',
      data: {
        post_id: '40',
        branch_id: '10',
        received_count: 3,
        order_count: 4,
        status: Post_status.SENT,
      },
      link: '/mails/40',
      recipient_ids: ['198', '199'],
      group_key: 'logistics:post:40',
      channels: ['in_app', 'realtime'],
    });
  });

  it.each([
    [{ recipient_ids: [] }],
    [{ recipient_ids: ['0', null] }],
    [{ received_count: 0 }],
    [{ post_id: null }],
    [{ post_id: 'abc' }],
  ])('%j — payload yo‘q', (overrides) => {
    expect(
      buildBatchArrivedPayload({
        post_id: '40',
        branch_id: '10',
        received_count: 2,
        order_count: 2,
        recipient_ids: ['198'],
        ...(overrides as object),
      }),
    ).toBeNull();
  });
});

describe('resolveBranchStaffIds — tranzaksiyadan tashqari, qisqa timeout, kesh, fail-open', () => {
  const requester = { id: '198', roles: ['manager'] };

  it('faqat MANAGER / REGISTRATOR (kuryer emas), takrorsiz; requester uzatiladi', async () => {
    const branchClient = { send: jest.fn(() => of({ data: STAFF_ROWS })) };
    const notifier = new LogisticsNotificationService(
      {} as never,
      branchClient as never,
    );
    await expect(
      notifier.resolveBranchStaffIds('10', requester),
    ).resolves.toEqual(['198', '199']);
    expect(branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_branch' },
      { branch_id: '10', requester },
    );
  });

  it('kesh: ikkinchi chaqiruv RPC qilmaydi', async () => {
    const branchClient = { send: jest.fn(() => of({ data: STAFF_ROWS })) };
    const notifier = new LogisticsNotificationService(
      {} as never,
      branchClient as never,
    );
    await notifier.resolveBranchStaffIds('10', requester);
    await notifier.resolveBranchStaffIds('10', requester);
    expect(branchClient.send).toHaveBeenCalledTimes(1);
  });

  it('timeout / xato — [] (reject YO‘Q), xato keshlanmaydi', async () => {
    const branchClient = {
      send: jest
        .fn()
        .mockReturnValueOnce(throwError(() => new TimeoutError()))
        .mockReturnValueOnce(of({ data: STAFF_ROWS })),
    };
    const notifier = new LogisticsNotificationService(
      {} as never,
      branchClient as never,
    );
    await expect(
      notifier.resolveBranchStaffIds('10', requester),
    ).resolves.toEqual([]);
    await expect(
      notifier.resolveBranchStaffIds('10', requester),
    ).resolves.toEqual(['198', '199']);
  });

  it('timeout chegarasi qisqa (pochta qabulini sekinlatmasin)', () => {
    expect(BRANCH_STAFF_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });

  it('yaroqsiz filial id — RPC yo‘q', async () => {
    const branchClient = { send: jest.fn() };
    const notifier = new LogisticsNotificationService(
      {} as never,
      branchClient as never,
    );
    await expect(
      notifier.resolveBranchStaffIds('', requester),
    ).resolves.toEqual([]);
    expect(branchClient.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integratsiya: receivePost (haqiqiy servis + haqiqiy OutboxService +
// xotiradagi tranzaksiya).
// ---------------------------------------------------------------------------

const onTheRoad = (id: string): Row => ({
  id,
  status: Order_status.ON_THE_ROAD,
  branch_id: '10',
  post_id: '40',
  total_price: 100_000,
});

function setup(
  options: {
    post?: Row;
    updateErrors?: Record<string, unknown>;
    staff?: () => ReturnType<typeof of>;
    outboxError?: Error;
    withNotifier?: boolean;
  } = {},
) {
  const snapshot = [onTheRoad('101'), onTheRoad('102')];
  const orderClient = {
    send: jest.fn(
      (pattern: { cmd: string }, payload: { id?: string; query?: Row }) => {
        if (pattern.cmd === 'order.find_all') {
          if (payload.query?.status === Order_status.ON_THE_ROAD) {
            return of({ data: { data: [] } });
          }
          return of({ data: { data: snapshot } });
        }
        if (pattern.cmd === 'order.update') {
          const error = options.updateErrors?.[String(payload.id)];
          return error ? throwError(() => error) : of({ statusCode: 200 });
        }
        if (pattern.cmd === 'order.find_by_id') {
          return of({ id: payload.id, status: Order_status.WAITING });
        }
        return of({});
      },
    ),
  };
  const post: Row = options.post ?? {
    id: '40',
    courier_id: '0',
    branch_id: '10',
    region_id: '14',
    status: Post_status.SENT,
  };

  const committed: Row[] = [];
  let pending: Row[] = [];
  const outboxRepo = {
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      if (options.outboxError) return Promise.reject(options.outboxError);
      pending.push(value);
      return Promise.resolve({ id: String(pending.length), ...value });
    }),
  };
  const txPostRepo = {
    save: jest.fn((entity: Row) => Promise.resolve({ ...entity })),
  };
  const txManager: Row = {
    queryRunner: { isTransactionActive: true },
    getRepository: jest.fn((entity: unknown) => {
      if (entity === OutboxEvent) return outboxRepo;
      if (entity === Post) return txPostRepo;
      throw new Error('unexpected repository');
    }),
  };
  const transaction = jest.fn(
    async (work: (manager: Row) => Promise<unknown>) => {
      try {
        const result = await work(txManager);
        committed.push(...pending);
        pending = [];
        return result;
      } catch (error) {
        pending = [];
        throw error;
      }
    },
  );
  const postRepo = {
    findOne: jest.fn().mockResolvedValue(post),
    save: jest.fn((entity: Row) => Promise.resolve({ ...entity })),
    manager: { transaction },
  };

  const notifierBranchClient = {
    send: jest.fn(options.staff ?? (() => of({ data: STAFF_ROWS }))),
  };
  const defaultOutboxRepo = { create: jest.fn(), save: jest.fn() };
  const notifier = new LogisticsNotificationService(
    new OutboxService(defaultOutboxRepo as never),
    notifierBranchClient as never,
  );
  const notificationClient = {
    send: jest.fn(() => {
      throw new Error('notification-service o‘chiq');
    }),
    emit: jest.fn(() => {
      throw new Error('notification-service o‘chiq');
    }),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    {} as any,
    orderClient as any,
    { send: jest.fn(() => of({ data: null })) } as any,
    {} as any,
    { send: jest.fn(() => of({})) } as any,
    activityLog as any,
    options.withNotifier === false ? undefined : notifier,
  );
  const notifications = () =>
    committed.filter((row) => row.target === NOTIFICATION_OUTBOX_TARGET);
  return {
    service,
    postRepo,
    txPostRepo,
    transaction,
    committed,
    notifications,
    notifierBranchClient,
    defaultOutboxRepo,
    notificationClient,
  };
}

const manager10 = { id: '198', roles: ['manager'], branch_id: '10' };

describe('receivePost → logistics.batch_arrived', () => {
  it('filiallararo pochta filialga qabul qilindi — outbox_events da target=NOTIFICATION, pattern=notification.dispatch (pochta holati bilan BITTA tranzaksiyada)', async () => {
    const ctx = setup();
    const res: Row = await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.transaction).toHaveBeenCalledTimes(1);
    // pochta holati tranzaksiya menejeri orqali saqlandi (oddiy save emas)
    expect(ctx.txPostRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '40', status: Post_status.RECEIVED }),
    );
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
    expect(ctx.notifications()).toHaveLength(1);
    expect(ctx.notifications()[0]).toEqual(
      expect.objectContaining({
        target: 'NOTIFICATION',
        pattern: 'notification.dispatch',
        status: 'pending',
        payload: expect.objectContaining({
          type: 'logistics.batch_arrived',
          category: 'logistics',
          recipient_ids: ['198', '199'],
          link: '/mails/40',
          group_key: 'logistics:post:40',
          body: 'Pochta #40 filialga qabul qilindi: 2 ta buyurtma.',
          request_id: expect.any(String),
        }),
      }),
    );
    expect(ctx.defaultOutboxRepo.save).not.toHaveBeenCalled();
    // nishon filial bo'yicha aniqlandi (global `roles` emas)
    expect(ctx.notifierBranchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_branch' },
      expect.objectContaining({ branch_id: '10' }),
    );
  });

  it('qisman qabul — faqat haqiqatan qabul qilingan buyurtmalar soni', async () => {
    const ctx = setup({ updateErrors: { '102': new Error('update failed') } });
    await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });
    expect(ctx.notifications()[0].payload.data.received_count).toBe(1);
  });

  it('rollback: outbox yozilmasa — tranzaksiya qaytariladi, pochta bildirishnomasiz saqlanadi (qabul qilish YIQILMAYDI)', async () => {
    const ctx = setup({ outboxError: new Error('relation does not exist') });
    const res: Row = await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.committed).toEqual([]);
    expect(ctx.postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '40', status: Post_status.RECEIVED }),
    );
  });

  it('pochta yozuvining o‘zi yiqilsa — xato avvalgidek chaqiruvchiga (qayta urinish ham o‘sha xato)', async () => {
    const ctx = setup();
    ctx.txPostRepo.save.mockRejectedValue(new Error('db down'));
    ctx.postRepo.save.mockRejectedValue(new Error('db down'));
    await expect(
      ctx.service.receivePost(manager10, '40', { order_ids: ['101', '102'] }),
    ).rejects.toThrow('db down');
    expect(ctx.committed).toEqual([]);
  });

  it('TC3 analogi: branch-service / notification-service o‘chiq — pochta baribir qabul qilinadi, bildirishnoma yo‘q', async () => {
    const ctx = setup({
      staff: () => throwError(() => new TimeoutError()) as never,
    });
    const res: Row = await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.transaction).not.toHaveBeenCalled();
    expect(ctx.postRepo.save).toHaveBeenCalledTimes(1);
    expect(ctx.notifications()).toEqual([]);
    expect(ctx.notificationClient.send).not.toHaveBeenCalled();
    expect(ctx.notificationClient.emit).not.toHaveBeenCalled();
  });

  it('hech narsa qabul qilinmadi (hammasi yiqildi) — bildirishnoma yo‘q, oddiy save', async () => {
    const error = new Error('update failed');
    const ctx = setup({ updateErrors: { '101': error, '102': error } });
    await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });
    expect(ctx.transaction).not.toHaveBeenCalled();
    expect(ctx.notifications()).toEqual([]);
  });

  it('kuryer o‘z pochtasini qabul qildi — filialga kelish EMAS: qidiruv ham, bildirishnoma ham yo‘q', async () => {
    const ctx = setup({
      post: {
        id: '40',
        courier_id: '77',
        branch_id: '10',
        region_id: '14',
        status: Post_status.SENT,
      },
    });
    await ctx.service.receivePost(
      { id: '77', roles: ['courier'], branch_id: '10' },
      '40',
      { order_ids: ['101', '102'] },
    );
    expect(ctx.notifierBranchClient.send).not.toHaveBeenCalled();
    expect(ctx.transaction).not.toHaveBeenCalled();
    expect(ctx.notifications()).toEqual([]);
  });

  it('notifier ulanmagan (eski 8 argumentli konstruktor) — pochta avvalgidek oddiy save', async () => {
    const ctx = setup({ withNotifier: false });
    await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });
    expect(ctx.transaction).not.toHaveBeenCalled();
    expect(ctx.postRepo.save).toHaveBeenCalledTimes(1);
  });
});

describe('onBatchArrived — xato semantikasi (order-service naqshi)', () => {
  const input = {
    post_id: '40',
    branch_id: '10',
    received_count: 1,
    order_count: 1,
    recipient_ids: ['198'],
  };

  it('tranzaksiya ichida outbox DB xatosi — qayta otiladi (chaqiruvchi rollback qiladi)', async () => {
    const outbox = { enqueue: jest.fn().mockRejectedValue(new Error('db')) };
    const notifier = new LogisticsNotificationService(
      outbox as never,
      {} as never,
    );
    await expect(
      notifier.onBatchArrived(input, {
        queryRunner: { isTransactionActive: true },
      } as never),
    ).rejects.toThrow('db');
  });

  it('tranzaksiyasiz yo‘lda — yutiladi (WARN)', async () => {
    const outbox = { enqueue: jest.fn().mockRejectedValue(new Error('db')) };
    const notifier = new LogisticsNotificationService(
      outbox as never,
      {} as never,
    );
    await expect(notifier.onBatchArrived(input)).resolves.toBeUndefined();
  });

  it('payload qurishda kutilmagan xato — tranzaksiya ichida ham YIQILMAYDI', async () => {
    const outbox = { enqueue: jest.fn() };
    const notifier = new LogisticsNotificationService(
      outbox as never,
      {} as never,
    );
    await expect(
      notifier.onBatchArrived(
        {
          ...input,
          get recipient_ids(): string[] {
            throw new Error('bug');
          },
        },
        { queryRunner: { isTransactionActive: true } } as never,
      ),
    ).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('modul ulanishi, migratsiya va TC5 analogi', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('logistics-service.module.ts: NOTIFICATION mijozi, OutboxModule targets va fireAndForgetPatterns', () => {
    const src = strip(
      readFileSync(join(SRC, 'logistics-service.module.ts'), 'utf8'),
    );
    expect(src).toMatch(
      /RmqModule\.register\(\{\s*name:\s*'NOTIFICATION'\s*\}\)/,
    );
    expect(src).toMatch(
      /OutboxModule\.forService\(\{\s*targets:\s*\[\s*'NOTIFICATION'\s*\]/,
    );
    expect(src).toMatch(
      /fireAndForgetPatterns:\s*\[\s*'notification\.dispatch'\s*\]/,
    );
    expect(src).toMatch(/LogisticsNotificationService/);
  });

  it('migrations/1716000000064 — logistics_schema.outbox_events (up + down)', () => {
    const file = readdirSync(join(SRC, '..', '..', '..', 'migrations')).find(
      (name) => name.startsWith('1716000000064-'),
    );
    expect(file).toBeDefined();
    const src = readFileSync(
      join(SRC, '..', '..', '..', 'migrations', file!),
      'utf8',
    );
    expect(src).toContain(
      'CREATE TABLE IF NOT EXISTS "logistics_schema"."outbox_events"',
    );
    expect(src).toContain(
      'DROP TABLE IF EXISTS "logistics_schema"."outbox_events"',
    );
    // OutboxEvent entity ustunlari
    for (const column of [
      'target',
      'pattern',
      'payload',
      'status',
      'attempts',
      'last_error',
      'scheduled_at',
      'published_at',
      'created_at',
    ]) {
      expect(src).toContain(`"${column}"`);
    }
  });

  it('grep bo‘sh: notification.dispatch faqat outbox orqali, NOTIFICATION mijozi inject qilinmaydi', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
    )) {
      const src = strip(readFileSync(file, 'utf8'));
      if (
        /rmqSend\([^;]*notification\.dispatch/s.test(src) ||
        /\.(send|emit)\(\s*\{\s*cmd:\s*['"]notification\./.test(src) ||
        /@Inject\(\s*['"]NOTIFICATION['"]\s*\)/.test(src)
      ) {
        offenders.push(file.replace(SRC, ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pattern konstantalari', () => {
    expect(NOTIFICATION_OUTBOX_TARGET).toBe('NOTIFICATION');
    expect(NOTIFICATION_DISPATCH_PATTERN).toBe('notification.dispatch');
  });
});
