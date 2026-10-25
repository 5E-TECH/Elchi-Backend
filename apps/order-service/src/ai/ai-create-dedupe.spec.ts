/**
 * Cp2v3ZJ7 (barqaror kalit + mazmun imzosi) va vncdmXOy (AI audit metadata)
 * — order-service `order.create` tomoni. Haqiqiy `executeIdempotent` ishlaydi,
 * IdempotencyService esa xotiradagi soxta jadval (kalit → holat).
 */
import { RpcException, type RmqContext } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Order } from '../entities/order.entity';
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';
import { OrderServiceController } from '../order-service.controller';
import {
  AI_SIGNATURE_TTL_MS,
  isAiStableRequestId,
  runWithAiSignature,
  sanitizeAiAuditMetadata,
} from './ai-create-dedupe';

const stub = <T>(value: unknown): T => value as T;
const ctx = stub<RmqContext>({});

const MARKET = '121';
const DRAFT = '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4';
const STABLE = `ai:${MARKET}:${DRAFT}:0`;
const SIG = 'b'.repeat(64);
const DTO = {
  market_id: MARKET,
  customer_id: '55',
  district_id: '20',
  total_price: 320000,
  items: [{ product_id: '12', quantity: 1 }],
};
const REQUESTER = { id: '7', roles: ['market'] };
const AUDIT = {
  ai: true,
  ai_draft_id: DRAFT,
  ai_item_index: 0,
  ai_draft_verified: true,
  model: 'claude-sonnet-5',
  prompt_version: '2026-09-27.1',
  ai_cost_uzs: 64,
  ai_draft_cost_uzs: 128,
  edited_fields: ['district_id', 'total_price'],
};

type Entry = {
  status: 'in_progress' | 'completed' | 'failed';
  response?: unknown;
  error?: unknown;
  at: number;
};

/** tryAcquire semantikasining minimal nusxasi (TTL / reclaimFailed / lease). */
function memoryIdempotency() {
  const rows = new Map<string, Entry>();
  const service = {
    rows,
    tryAcquire: jest.fn(
      (
        key: string,
        _pattern: string,
        leaseMs = 30_000,
        opts?: { completedTtlMs?: number; reclaimFailed?: boolean },
      ) => {
        const row = rows.get(key);
        const now = Date.now();
        if (!row) {
          rows.set(key, { status: 'in_progress', at: now });
          return Promise.resolve({ status: 'new' });
        }
        if (row.status === 'completed') {
          if (
            opts?.completedTtlMs !== undefined &&
            now - row.at > opts.completedTtlMs
          ) {
            rows.set(key, { status: 'in_progress', at: now });
            return Promise.resolve({ status: 'new' });
          }
          return Promise.resolve({ status: 'cached', response: row.response });
        }
        if (row.status === 'failed') {
          if (opts?.reclaimFailed) {
            rows.set(key, { status: 'in_progress', at: now });
            return Promise.resolve({ status: 'new' });
          }
          return Promise.resolve({ status: 'failed', error: row.error });
        }
        if (now - row.at > leaseMs) {
          rows.set(key, { status: 'in_progress', at: now });
          return Promise.resolve({ status: 'new' });
        }
        return Promise.resolve({ status: 'in_progress' });
      },
    ),
    markCompleted: jest.fn((key: string, response: unknown) => {
      rows.set(key, { status: 'completed', response, at: Date.now() });
      return Promise.resolve();
    }),
    markFailed: jest.fn((key: string, error: unknown) => {
      rows.set(key, { status: 'failed', error, at: Date.now() });
      return Promise.resolve();
    }),
  };
  return service;
}

function setup() {
  const rmqService = {
    ack: jest.fn(),
    nack: jest.fn(),
    nackForError: jest.fn(),
  };
  let next = 9000;
  const lifecycle = {
    create: jest.fn(() =>
      Promise.resolve({
        statusCode: 201,
        message: 'success',
        data: { id: String(++next) },
      }),
    ),
  };
  const idem = memoryIdempotency();
  const controller = new OrderServiceController(
    stub(rmqService),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub(lifecycle),
    stub(idem),
    stub({ resolve: jest.fn() }),
  );
  return { controller, lifecycle, idem, rmqService };
}

async function rpcBody(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcException)
      return e.getError() as Record<string, unknown>;
    throw e;
  }
  throw new Error('RpcException kutilgan edi');
}

describe('isAiStableRequestId', () => {
  it.each([
    [STABLE, true],
    [`ai:${MARKET}:${DRAFT}:29`, true],
    [`ai-dedupe:${SIG}`, false],
    [`ai:${DRAFT}:0`, false],
    ['3f1c2b1e-9a55-4d8e-8c1b-2f7a9c0d1e2f', false],
    [undefined, false],
  ])('%s → %s', (id, expected) => {
    expect(isAiStableRequestId(id)).toBe(expected);
  });
});

describe('order.create — barqaror kalit (Cp2v3ZJ7)', () => {
  const send = (
    c: OrderServiceController,
    extra: Record<string, unknown> = {},
  ) =>
    c.create(
      {
        dto: DTO,
        requester: REQUESTER,
        request_id: STABLE,
        ai_signature: SIG,
        ai_audit: AUDIT,
        ...extra,
      },
      ctx,
    );

  it('TC1/TC2/TC10: bir xil draft+index ikki marta → BITTA buyurtma, ikkinchisi idempotent_replay bilan o‘sha order_id', async () => {
    const { controller, lifecycle } = setup();
    const first = (await send(controller)) as { data: { id: string } };
    const second = (await send(controller)) as {
      data: { id: string };
      idempotent_replay?: boolean;
    };
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    expect(second.data.id).toBe(first.data.id);
    expect(second.idempotent_replay).toBe(true);
    expect(first).not.toHaveProperty('idempotent_replay');
  });

  it('barqaror kalit kesh TTL’siz (muddatsiz) — 10 daqiqadan keyin ham qayta yaratilmaydi', async () => {
    const { controller, lifecycle, idem } = setup();
    await send(controller);
    // Barqaror kalitni "eskirtiramiz" — TTL yo'qligi uchun baribir kesh.
    idem.rows.get(`order.create:${STABLE}`)!.at -= AI_SIGNATURE_TTL_MS * 10;
    await send(controller);
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    const stableCall = idem.tryAcquire.mock.calls.find(
      (c) => c[0] === `order.create:${STABLE}`,
    )!;
    expect(stableCall[3]).toEqual({
      completedTtlMs: undefined,
      reclaimFailed: true,
    });
  });

  it('TC8: boshqa draft’dan AYNI mazmun 10 daqiqa ichida → 409 duplicate_recent + birinchi order_id', async () => {
    const { controller, lifecycle } = setup();
    const first = (await send(controller)) as { data: { id: string } };
    const other = `ai:${MARKET}:1b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4:0`;
    const body = await rpcBody(send(controller, { request_id: other }));
    expect(body).toMatchObject({
      statusCode: 409,
      code: 'duplicate_recent',
      order_id: first.data.id,
    });
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
  });

  it('TC9: 10 daqiqadan keyin o‘sha imzo bilan (yangi draft) yaratishga RUXSAT', async () => {
    const { controller, lifecycle, idem } = setup();
    await send(controller);
    idem.rows.get(`order.create:ai-dedupe:${SIG}`)!.at -=
      AI_SIGNATURE_TTL_MS + 1;
    const other = `ai:${MARKET}:1b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4:0`;
    await send(controller, { request_id: other });
    expect(lifecycle.create).toHaveBeenCalledTimes(2);
  });

  it('TC9: duplicate_recent bo‘lgan band keyin (TTL o‘tgach) qayta yuborilsa yaratiladi (kalit zaharlanmaydi)', async () => {
    const { controller, lifecycle, idem } = setup();
    await send(controller);
    const other = `ai:${MARKET}:1b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4:3`;
    await rpcBody(send(controller, { request_id: other }));
    idem.rows.get(`order.create:ai-dedupe:${SIG}`)!.at -=
      AI_SIGNATURE_TTL_MS + 1;
    await send(controller, { request_id: other });
    expect(lifecycle.create).toHaveBeenCalledTimes(2);
  });

  it('TC6: parallel ikkinchi so‘rov (birinchisi hali ishlayapti) → 409 in_progress, dublikat yo‘q', async () => {
    const { controller, lifecycle } = setup();
    let release!: () => void;
    lifecycle.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ statusCode: 201, message: 'ok', data: { id: '1' } });
        }),
    );
    const firstP = send(controller);
    await new Promise((r) => setImmediate(r));
    const body = await rpcBody(send(controller));
    expect(String(body.message)).toContain('Idempotency in_progress');
    expect(body.statusCode).toBe(409);
    release();
    await firstP;
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
  });

  it('TC7: 30s dan eski in_progress (yiqilgan worker) keyingi chaqiruvda tiklanadi va ish bajariladi', async () => {
    const { controller, lifecycle, idem } = setup();
    idem.rows.set(`order.create:${STABLE}`, {
      status: 'in_progress',
      at: Date.now() - 31_000,
    });
    await send(controller);
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
  });

  it('TC5: yiqilgan band qayta yuborilsa qayta urinadi; muvaffaqiyatli band qayta yaratilmaydi', async () => {
    const { controller, lifecycle } = setup();
    lifecycle.create.mockRejectedValueOnce(
      new RpcException({ statusCode: 400, message: 'telefon xato' }),
    );
    await rpcBody(send(controller));
    await send(controller); // qayta urinish — yaratiladi
    await send(controller); // uchinchi — replay
    expect(lifecycle.create).toHaveBeenCalledTimes(2);
  });

  it('vncdmXOy TC1: AI metadata lifecycle.create ga oq ro‘yxatdan o‘tib uzatiladi', async () => {
    const { controller, lifecycle } = setup();
    await send(controller, {
      ai_audit: { ...AUDIT, operator_id: '666', evil: 'x' },
    });
    const calls = lifecycle.create.mock.calls as unknown as unknown[][];
    const opts = calls[0][2] as { auditMetadata: Record<string, unknown> };
    expect(opts.auditMetadata).toMatchObject({
      ai: true,
      ai_draft_id: DRAFT,
      ai_item_index: 0,
      edited_fields: ['district_id', 'total_price'],
    });
    expect(opts.auditMetadata).not.toHaveProperty('operator_id');
    expect(opts.auditMetadata).not.toHaveProperty('evil');
  });

  it('vncdmXOy TC2: oddiy POST /orders (UUID request_id) ai_audit bera olmaydi', async () => {
    const { controller, lifecycle } = setup();
    await controller.create(
      {
        dto: DTO,
        requester: REQUESTER,
        request_id: '3f1c2b1e-9a55-4d8e-8c1b-2f7a9c0d1e2f',
        ai_audit: AUDIT,
      },
      ctx,
    );
    expect(lifecycle.create).toHaveBeenCalledWith(DTO, REQUESTER);
  });
});

describe('runWithAiSignature', () => {
  it('imzo yaroqsiz bo‘lsa — qatlamsiz create', async () => {
    const idem = memoryIdempotency();
    const create = jest.fn().mockResolvedValue({ data: { id: '1' } });
    await runWithAiSignature(idem, 'not-a-sha', create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(idem.tryAcquire).not.toHaveBeenCalled();
  });
});

describe('sanitizeAiAuditMetadata', () => {
  it('draft_id yo‘q / yaroqsiz → null', () => {
    expect(sanitizeAiAuditMetadata({ ai: true })).toBeNull();
    expect(sanitizeAiAuditMetadata({ ai_draft_id: 'x' })).toBeNull();
    expect(sanitizeAiAuditMetadata(null)).toBeNull();
  });

  it('ai_item_index yuborilmagan / null / bo‘sh → null (0 EMAS); 0 va "2" saqlanadi', () => {
    for (const value of [undefined, null, '']) {
      expect(
        sanitizeAiAuditMetadata({ ai_draft_id: DRAFT, ai_item_index: value }),
      ).toMatchObject({ ai_item_index: null });
    }
    expect(
      sanitizeAiAuditMetadata({ ai_draft_id: DRAFT, ai_item_index: 0 }),
    ).toMatchObject({ ai_item_index: 0 });
    expect(
      sanitizeAiAuditMetadata({ ai_draft_id: DRAFT, ai_item_index: '2' }),
    ).toMatchObject({ ai_item_index: 2 });
  });

  it('noma’lum edited_fields tashlanadi, ai:true majburan', () => {
    expect(
      sanitizeAiAuditMetadata({
        ai: false,
        ai_draft_id: DRAFT,
        edited_fields: ['district_id', 'status', 'district_id'],
      }),
    ).toMatchObject({ ai: true, edited_fields: ['district_id'] });
  });
});

describe('lifecycle.create — CREATED metadata (vncdmXOy TC1/TC2)', () => {
  function harness() {
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: unknown) =>
          entity === Order
            ? {
                create: jest.fn((v: Record<string, unknown>) => v),
                save: jest.fn((v: Record<string, unknown>) =>
                  Promise.resolve({ id: '900', product_quantity: 0, ...v }),
                ),
                update: jest.fn(),
              }
            : // IR2OHIiN: mahsulot qatorlari endi DOIM yoziladi.
              {
                createQueryBuilder: () => ({
                  insert: () => ({ values: () => ({ execute: jest.fn() }) }),
                }),
              },
        ),
      },
    };
    const s = Object.create(
      OrderLifecycleService.prototype,
    ) as OrderLifecycleService & Record<string, unknown>;
    const log = jest.fn().mockResolvedValue(undefined);
    Object.assign(s, {
      dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
      branchClient: { send: jest.fn(() => of({ data: null })) },
      lookup: {
        getHqBranchId: jest.fn().mockResolvedValue('1'),
        getBranchAssignmentByUserStrict: jest.fn().mockResolvedValue(null),
      },
      custody: {
        createTrackingEvent: jest.fn().mockResolvedValue(undefined),
        createCustodyEvent: jest.fn().mockResolvedValue(undefined),
        toTrackingRole: jest.fn(() => 'system'),
        auditActor: jest.fn(() => ({})),
      },
      syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
      activityLog: { log },
      findById: jest.fn().mockResolvedValue({ id: '900' }),
    });
    return { s, log };
  }
  const dto = {
    market_id: '501',
    customer_id: '801',
    total_price: 200000,
    // IR2OHIiN: mahsulot va tuman majburiy.
    district_id: '12',
    region_id: '3',
    items: [{ product_id: '41', quantity: 1 }],
  };

  it('AI buyurtma: metadata.ai === true, ai_draft_id; operator_id ALMASHTIRILMAYDI', async () => {
    const { s, log } = harness();
    await s.create(
      dto,
      { id: '7', roles: ['market'] },
      {
        auditMetadata: { ai: true, ai_draft_id: DRAFT, operator_id: '666' },
      },
    );
    const entry = log.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(entry.metadata).toMatchObject({ ai: true, ai_draft_id: DRAFT });
    expect(entry.metadata.operator_id).not.toBe('666');
  });

  it('qo‘lda yaratilgan buyurtma: metadata.ai YO‘Q (avvalgidek {operator_id})', async () => {
    const { s, log } = harness();
    await s.create(dto, { id: '7', roles: ['market'] });
    const entry = log.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(entry.metadata).not.toHaveProperty('ai');
    expect(Object.keys(entry.metadata)).toEqual(['operator_id']);
  });
});
