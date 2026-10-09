import { requestContext } from '../context/request-context';
import { ActivityLog } from './activity-log.entity';
import {
  ACTIVITY_DESCRIPTION_MAX,
  ActivityLogService,
} from './activity-log.service';

type Row = Partial<ActivityLog>;

function makeService() {
  const saved: Row[] = [];
  const qb = {
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const repo = {
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => {
      saved.push(row);
      return Promise.resolve(row);
    }),
    createQueryBuilder: jest.fn(() => qb),
  };
  const service = new ActivityLogService(repo as never, 'order-service');
  return { service, repo, saved, qb };
}

const HTTP_CTX = {
  traceId: 'trace-1',
  ip: '203.0.113.7',
  user_agent:
    'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36',
  device_id: 'dev-123',
  device_name: 'Telefon · Android · Chrome',
};

describe('ActivityLogService.log — description (2WRzdWpZ)', () => {
  it('TC2 description berilmasa yozuv avvalgidek, ustun NULL', async () => {
    const { service, saved } = makeService();
    await service.log({
      entity_type: 'Order',
      entity_id: 7,
      action: 'created',
      metadata: { market_id: '501' },
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      entity_type: 'Order',
      entity_id: '7',
      action: 'created',
      description: null,
      metadata: { market_id: '501' },
      service: 'order-service',
    });
  });

  it('description saqlanadi, bo`shliqlar yig`iladi, bo`sh satr → NULL', async () => {
    const { service, saved } = makeService();
    await service.log({
      entity_type: 'Order',
      entity_id: '7',
      action: 'order.cancel',
      description: '  Buyurtma   #7\nbekor qilindi ',
    });
    await service.log({
      entity_type: 'Order',
      entity_id: '7',
      action: 'order.cancel',
      description: '   ',
    });
    expect(saved[0].description).toBe('Buyurtma #7 bekor qilindi');
    expect(saved[1].description).toBeNull();
  });

  it('TC6 himoya qatlami: gapga tushib qolgan telefon maskalanadi', async () => {
    const { service, saved } = makeService();
    await service.log({
      entity_type: 'Order',
      entity_id: '7',
      action: 'updated',
      description: 'Mijoz 90 123 45 67 bilan gaplashildi',
    });
    expect(saved[0].description).not.toContain('123 45 67');
    expect(saved[0].description).toContain('+99890*****67');
  });

  it('uzun gap cheklanadi', async () => {
    const { service, saved } = makeService();
    await service.log({
      entity_type: 'Order',
      entity_id: '7',
      action: 'updated',
      description: 'a'.repeat(ACTIVITY_DESCRIPTION_MAX + 100),
    });
    expect(saved[0].description).toHaveLength(ACTIVITY_DESCRIPTION_MAX);
  });

  it('logChange description`ni uzatadi', async () => {
    const { service, saved } = makeService();
    await service.logChange({
      entity_type: 'Order',
      entity_id: '7',
      old_value: { status: 'new' },
      new_value: { status: 'received' },
      description: 'Buyurtma #7 holati: Yangi → Qabul qilindi',
    });
    expect(saved[0].description).toBe(
      'Buyurtma #7 holati: Yangi → Qabul qilindi',
    );
  });
});

describe('ActivityLogService.query — qidiruv (2WRzdWpZ TC7)', () => {
  it('search description ustunini ham ILIKE bilan qamraydi', async () => {
    const { service, qb } = makeService();
    await service.query({ search: ' bekor ' });
    const searchCall = qb.andWhere.mock.calls.find(([sql]) =>
      String(sql).includes(':s'),
    );
    expect(searchCall).toBeDefined();
    expect(searchCall![0]).toContain('a.description ILIKE :s');
    // Avvalgi ustunlar ham saqlangan (regressiya).
    for (const col of [
      'a.entity_type',
      'a.entity_id',
      'a.action',
      'a.user_name',
    ]) {
      expect(searchCall![0]).toContain(`${col} ILIKE :s`);
    }
    expect(searchCall![1]).toEqual({ s: '%bekor%' });
  });
});

describe('ActivityLogService.log — IP/qurilma konteksti (f2Ud5tju)', () => {
  it('TC1 HTTP kontekstida metadata ga ip, user_agent, device_* qo`shiladi', async () => {
    const { service, saved } = makeService();
    await requestContext.run(HTTP_CTX, () =>
      service.log({
        entity_type: 'Order',
        entity_id: '7',
        action: 'order.sell',
        metadata: { market_id: '501' },
      }),
    );
    expect(saved[0].metadata).toEqual({
      ip: '203.0.113.7',
      user_agent: HTTP_CTX.user_agent,
      device_id: 'dev-123',
      device_name: 'Telefon · Android · Chrome',
      market_id: '501',
    });
    expect(saved[0].trace_id).toBe('trace-1');
  });

  it('TC1 metadata berilmagan amalda ham kontekst yoziladi', async () => {
    const { service, saved } = makeService();
    await requestContext.run(HTTP_CTX, () =>
      service.log({ entity_type: 'Auth', entity_id: '1', action: 'login' }),
    );
    expect(saved[0].metadata).toMatchObject({
      ip: '203.0.113.7',
      device_name: 'Telefon · Android · Chrome',
    });
  });

  it('TC2 cron/bot (kontekst yo`q) — maydonlar YO`Q, sun`iy qiymat yo`q', async () => {
    const { service, saved } = makeService();
    await service.log({
      entity_type: 'Order',
      entity_id: '7',
      action: 'status_change',
      metadata: { reason: 'auto' },
    });
    await service.log({ entity_type: 'Order', entity_id: '8', action: 'x' });
    expect(saved[0].metadata).toEqual({ reason: 'auto' });
    expect(saved[1].metadata).toBeNull();
    expect(saved[1].trace_id).toBeNull();
  });

  it('TC2 faqat traceId li RMQ konteksti (outbox/cron emas) — IP qo`shilmaydi', async () => {
    const { service, saved } = makeService();
    await requestContext.run({ traceId: 't-2' }, () =>
      service.log({ entity_type: 'Order', entity_id: '7', action: 'x' }),
    );
    expect(saved[0].metadata).toBeNull();
    expect(saved[0].trace_id).toBe('t-2');
  });

  it('TC6 chaqiruvchi bergan ip USTUN — avtomatik qiymat ustiga yozmaydi', async () => {
    const { service, saved } = makeService();
    await requestContext.run(HTTP_CTX, () =>
      service.log({
        entity_type: 'Auth',
        entity_id: 'h',
        action: 'auth.otp_requested',
        metadata: { ip: '198.51.100.9', device_name: 'Mening telefonim' },
      }),
    );
    expect(saved[0].metadata).toMatchObject({
      ip: '198.51.100.9',
      device_name: 'Mening telefonim',
      user_agent: HTTP_CTX.user_agent,
    });
  });

  it('chaqiruvchidagi `undefined` avtomatik qiymatni o`chirmaydi, `null` o`chiradi', async () => {
    const { service, saved } = makeService();
    await requestContext.run(HTTP_CTX, () =>
      service.log({
        entity_type: 'Auth',
        entity_id: 'h',
        action: 'x',
        metadata: { ip: undefined, device_id: null },
      }),
    );
    expect(saved[0].metadata).toMatchObject({
      ip: '203.0.113.7',
      device_id: null,
    });
  });

  it('trace_id ustun chegarasi (64) dan uzun bo`lsa kesiladi — log yo`qolmaydi', async () => {
    const { service, saved } = makeService();
    await requestContext.run({ traceId: 'x'.repeat(200) }, () =>
      service.log({ entity_type: 'Order', entity_id: '7', action: 'x' }),
    );
    expect(saved[0].trace_id).toHaveLength(64);
  });
});

describe('ActivityLogService.prune — ip/qurilma qisqa muddati (f2Ud5tju)', () => {
  const DAY = 86_400_000;
  const NOW = new Date('2026-10-09T12:00:00.000Z').getTime();
  const ENV = 'ACTIVITY_LOG_DEVICE_RETENTION_DAYS';
  const savedEnv = process.env[ENV];

  function makePruneService(stripResults: unknown[] = []) {
    const deleteQb = {
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 3 }),
    };
    const repo = {
      metadata: { schema: 'integration_schema', tableName: 'activity_logs' },
      createQueryBuilder: jest.fn(() => deleteQb),
      query: jest.fn(() =>
        Promise.resolve(stripResults.shift() ?? [{ stripped: 0 }]),
      ),
    };
    const service = new ActivityLogService(repo as never, 'integration');
    return { service, repo, deleteQb };
  }

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    delete process.env[ENV];
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  const stripCalls = (repo: { query: jest.Mock }) =>
    repo.query.mock.calls as unknown as Array<[string, unknown[]]>;

  it('DELETE (umumiy muddat) o`zgarmagan, keyin sukut 30 kun bilan tozalash', async () => {
    const { service, repo, deleteQb } = makePruneService([
      [{ stripped: 4, last_id: '99' }],
    ]);

    await expect(service.prune(90 * DAY)).resolves.toBe(3);

    expect(deleteQb.where).toHaveBeenCalledWith('created_at < :cutoff', {
      cutoff: new Date(NOW - 90 * DAY),
    });
    const [[sql, params]] = stripCalls(repo);
    expect(sql).toContain('UPDATE "integration_schema"."activity_logs" AS t');
    expect(sql).toContain('s.created_at < $1');
    expect(params).toEqual([new Date(NOW - 30 * DAY), '0']);
  });

  it('env qisqa muddatni sozlaydi', async () => {
    process.env[ENV] = '7';
    const { service, repo } = makePruneService();
    await service.prune(90 * DAY);
    expect(stripCalls(repo)[0][1][0]).toEqual(new Date(NOW - 7 * DAY));
  });

  it('env umumiy muddatdan katta bo`lsa — umumiy muddat ustun', async () => {
    process.env[ENV] = '365';
    const { service, repo } = makePruneService();
    await service.prune(90 * DAY);
    expect(stripCalls(repo)[0][1][0]).toEqual(new Date(NOW - 90 * DAY));
  });

  it('tozalash xatosi DELETE natijasini yo`qotmaydi (best-effort)', async () => {
    const { service, repo } = makePruneService();
    repo.query.mockImplementation(() => Promise.reject(new Error('lock')));
    await expect(service.prune(90 * DAY)).resolves.toBe(3);
  });

  it('stripDeviceMetadata partiyalab ishlaydi va jami sonni qaytaradi', async () => {
    const { service, repo } = makePruneService([
      [{ stripped: 2, last_id: '5' }],
      [{ stripped: 1, last_id: '8' }],
    ]);
    await expect(service.stripDeviceMetadata(30 * DAY, 2)).resolves.toBe(3);
    expect(stripCalls(repo).map((c) => c[1][1])).toEqual(['0', '5']);
  });
});
