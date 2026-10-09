/**
 * ULANISH ISH REJIMI KALITLARI — MATRITSA (DOZ6dtJn).
 *
 *   master (`is_active`) — USTUN. O'chiq bo'lsa quyi kalitlar yoqiq bo'lsa
 *     ham HECH BIR jarayon ishlamaydi: kiruvchi webhook qo'llanmaydi,
 *     posilka jo'natilmaydi, holat navbati yuborilmaydi (lekin YO'QOLMAYDI —
 *     to'planib turadi), solishtiruv yo'q, tashqi HTTP so'rov umuman chiqmaydi.
 *   `webhook_enabled=false` — FAQAT kiruvchi webhook: jurnalga
 *     `skipped_disabled` bilan yoziladi, qo'llanmaydi. Chiquvchi jo'natish
 *     (dispatch), holat navbati va solishtiruvchi ISHLAYVERADI.
 *   `reconcile_enabled=false` — FAQAT cron: webhook va jo'natish ishlaydi.
 *
 * Prod testida (2026-10-09) "webhook_enabled=false bo'lganda dispatch
 * ishlayveradi" bandi spec yo'qligi sabab tasdiqlanmagan edi. Shu yerda
 * qulflanadi. Harness `integration-service.work-mode.spec.ts` bilan bir
 * uslub: prototipdan servis, repo'lar xotirada.
 */
import { FindOperator } from 'typeorm';
import { RpcException } from '@nestjs/microservices';
import { computeHmacSignature } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

type Row = Record<string, any>;

const SECRET = 'carrier-shared-secret';

const BASE: Row = {
  id: '5',
  slug: 'acme-cargo',
  name: 'Acme Kargo',
  isDeleted: false,
  is_active: true,
  webhook_enabled: true,
  reconcile_enabled: true,
  role: 'carrier',
  webhook_secret: SECRET,
  webhook_secret_previous: null,
  webhook_signature_header: 'x-signature',
  webhook_signature_prefix: null,
  webhook_algorithm: 'sha256',
  webhook_id_header: null,
  webhook_payload_paths: null,
  inbound_order_config: null,
  dispatch_config: {
    endpoint: '/v1/orders',
    method: 'POST',
    body_template: { ref: '{{order_id}}' },
  },
  status_sync_config: {
    status_query: {
      endpoint: '/shipments/{{external_ref}}',
      method: 'GET',
      status_path: 'data.status',
    },
    external_update: { endpoint: '/v1/status', method: 'POST' },
  },
};

const WEBHOOK_BODY = JSON.stringify({
  event: 'shipment.status_changed',
  shipment: { external_ref: 'EXT-1', status: 'delivered' },
});

async function rpcError(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; message?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as { statusCode?: number; message?: string };
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

/**
 * Xotiradagi repo uchun TypeORM `where` ning kichik baholovchisi — servis
 * ishlatadigan operatorlargina: IsNull, LessThanOrEqual, Not, In.
 */
function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof FindOperator) {
    const op = expected as FindOperator<unknown>;
    switch (op.type) {
      case 'isNull':
        return actual === null || actual === undefined;
      case 'lessThanOrEqual':
        return (
          actual instanceof Date &&
          actual.getTime() <= (op.value as Date).getTime()
        );
      case 'in':
        return (op.value as unknown[]).map(String).includes(String(actual));
      case 'not':
        return op.child
          ? !matchValue(actual, op.child)
          : !matchValue(actual, op.value);
      default:
        throw new Error(`baholovchida yo'q operator: ${op.type}`);
    }
  }
  return actual === expected;
}

function matchWhere(row: Row, where: Row | Row[] | undefined): boolean {
  if (!where) return true;
  const branches = Array.isArray(where) ? where : [where];
  return branches.some((branch) =>
    Object.entries(branch).every(([key, value]) => matchValue(row[key], value)),
  );
}

function queueRow(over: Row = {}): Row {
  return {
    id: 'q1',
    order_id: '101',
    integration_id: '5',
    action: 'sold',
    status: 'pending',
    attempts: 0,
    retry_count: 0,
    max_attempts: 4,
    payload: { order_id: '101' },
    external_order_id: 'EXT-1',
    external_status: 'delivered',
    next_retry_at: null,
    last_error: null,
    createdAt: new Date('2026-10-09T09:00:00Z'),
    ...over,
  };
}

function makeService(over: Row = {}) {
  const integration: Row = { ...BASE, ...over };
  const queue: Row[] = [];
  const svc = Object.create(IntegrationServiceService.prototype) as Row;

  const queryRunner = {
    connect: jest.fn(),
    release: jest.fn(),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('pg_try_advisory_lock') ? [{ acquired: true }] : [],
      ),
    ),
  };
  const connection = { createQueryRunner: jest.fn(() => queryRunner) };

  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.integrationRepo = {
    findOne: jest.fn((opts: { where?: Row }) =>
      Promise.resolve(
        matchWhere(integration, opts?.where) ? integration : null,
      ),
    ),
    find: jest.fn((opts: { where?: Row }) =>
      Promise.resolve(
        matchWhere(integration, opts?.where) ? [integration] : [],
      ),
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    save: jest.fn((row: Row) => Promise.resolve(row)),
    manager: { connection },
  };
  svc.syncQueueRepo = {
    findOne: jest.fn((opts: { where?: Row | Row[] }) =>
      Promise.resolve(
        [...queue]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .find((row) => matchWhere(row, opts?.where)) ?? null,
      ),
    ),
    save: jest.fn((row: Row) => Promise.resolve(row)),
    manager: { connection },
  };
  svc.webhookLogRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => ({ ...row })),
    save: jest.fn((row: Row) => Promise.resolve({ id: 'log1', ...row })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  svc.shipmentRepo = {
    find: jest
      .fn()
      .mockResolvedValue([
        { order_id: '101', external_ref: 'EXT-1', internal_status: 'new' },
      ]),
  };
  svc.activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  svc.orderClient = { send: jest.fn() };
  // Tekshirilayotgan mantiqdan tashqaridagi yo'llar.
  svc.decryptCredential = jest.fn((value: unknown) => value);
  svc.rmqRequest = jest
    .fn()
    .mockResolvedValue({ data: { id: '101', total_price: 100000 } });
  svc.upsertShipment = jest.fn().mockResolvedValue({});
  svc.writeSyncHistoryAttempt = jest.fn().mockResolvedValue(undefined);
  svc.notifyAdminsAboutPermanentFailure = jest
    .fn()
    .mockResolvedValue(undefined);
  svc.applyWebhookToShipment = jest
    .fn()
    .mockResolvedValue({ outcome: 'updated' });
  svc.applyProviderStatusToShipment = jest
    .fn()
    .mockResolvedValue({ outcome: 'updated' });
  svc.executeExternalRequest = jest.fn((input: Row) =>
    Promise.resolve({
      data: {
        raw: String(input.endpoint).startsWith('/shipments/')
          ? { data: { status: 'delivered' } }
          : { id: 'EXT-1' },
      },
    }),
  );
  return { svc, integration, queue };
}

const receive = (svc: Row) =>
  svc.receiveWebhook({
    slug: 'acme-cargo',
    raw_body_base64: Buffer.from(WEBHOOK_BODY, 'utf8').toString('base64'),
    headers: { 'x-signature': computeHmacSignature(WEBHOOK_BODY, SECRET) },
  });

describe('DOZ6dtJn — webhook_enabled=false: FAQAT kiruvchi oqim to`xtaydi', () => {
  const OFF = { webhook_enabled: false };

  it('⭐ kiruvchi webhook jurnalga skipped_disabled, posilkaga QO`LLANMAYDI', async () => {
    const { svc } = makeService(OFF);

    const res: Row = await receive(svc);

    expect(res).toMatchObject({
      ok: true,
      code: 200,
      reason: 'webhook_disabled',
      shipment: { outcome: 'skipped_disabled' },
    });
    expect(svc.webhookLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ signature_valid: true, status: 'verified' }),
    );
    expect(svc.webhookLogRepo.update).toHaveBeenCalledWith(
      { id: 'log1' },
      expect.objectContaining({ status: 'skipped_disabled' }),
    );
    expect(svc.applyWebhookToShipment).not.toHaveBeenCalled();
  });

  it('⭐ chiquvchi jo`natish (dispatch) ISHLAYVERADI', async () => {
    const { svc } = makeService(OFF);

    const res: Row = await svc.dispatchShipment({
      integration_id: '5',
      order_id: '101',
    });

    expect(res.statusCode).toBe(201);
    expect(svc.executeExternalRequest).toHaveBeenCalledTimes(1);
    expect(svc.executeExternalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'acme-cargo',
        endpoint: '/v1/orders',
        method: 'POST',
        body: { ref: '101' },
      }),
    );
    expect(svc.upsertShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '101',
        external_ref: null,
        last_error: null,
      }),
    );
  });

  it('⭐ chiquvchi holat navbati ham yuboriladi (sync queue)', async () => {
    const { svc, queue } = makeService(OFF);
    queue.push(queueRow());

    const res: Row = await svc.processPendingSyncQueue(20);

    expect(res.data).toMatchObject({ processed: 1, completed: 1, failed: 0 });
    expect(svc.executeExternalRequest).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'acme-cargo', endpoint: '/v1/status' }),
    );
    expect(queue[0].status).toBe('completed');
  });

  it('solishtiruvchi ham ishlaydi — yo`qolgan webhookni aynan u tutadi', async () => {
    const { svc } = makeService(OFF);

    const res: Row = await svc.reconcileNow({ id: '5' });

    expect(res.data).toMatchObject({ checked: 1, applied: 1 });
    expect(svc.applyProviderStatusToShipment).toHaveBeenCalledTimes(1);
  });
});

describe('DOZ6dtJn — reconcile_enabled=false: FAQAT cron to`xtaydi', () => {
  const OFF = { reconcile_enabled: false };

  it('cron bu ulanishni olmaydi', async () => {
    const { svc } = makeService(OFF);
    svc.reconcileIntegration = jest.fn();

    const res: Row = await svc.reconcileDueIntegrations(50);

    expect(res.data.results).toEqual([]);
    expect(svc.reconcileIntegration).not.toHaveBeenCalled();
  });

  it('⭐ kiruvchi webhook QO`LLANADI va dispatch ishlaydi', async () => {
    const { svc } = makeService(OFF);

    const res: Row = await receive(svc);
    await svc.dispatchShipment({ integration_id: '5', order_id: '101' });

    expect(res.reason).toBe('accepted');
    expect(svc.applyWebhookToShipment).toHaveBeenCalledTimes(1);
    expect(svc.executeExternalRequest).toHaveBeenCalledTimes(1);
  });
});

describe('DOZ6dtJn — master o`chiq: quyi kalitlar yoqiq bo`lsa ham HECH NARSA ishlamaydi', () => {
  // Quyi kalitlar ATAYLAB yoqiq: master ustunligi aynan shu holatda sinaladi.
  const MASTER_OFF = {
    is_active: false,
    webhook_enabled: true,
    reconcile_enabled: true,
  };

  it('⭐ kiruvchi webhook jurnalga yoziladi, lekin QO`LLANMAYDI (skipped_inactive)', async () => {
    const { svc } = makeService(MASTER_OFF);

    const res: Row = await receive(svc);

    expect(res).toMatchObject({
      ok: true,
      code: 200,
      reason: 'integration_inactive',
      shipment: { outcome: 'skipped_inactive' },
    });
    expect(svc.applyWebhookToShipment).not.toHaveBeenCalled();
  });

  it('⭐ dispatch — 400, tashqi so`rov yo`q', async () => {
    const { svc } = makeService(MASTER_OFF);

    const error = await rpcError(
      svc.dispatchShipment({ integration_id: '5', order_id: '101' }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("o'chirilgan");
    expect(svc.executeExternalRequest).not.toHaveBeenCalled();
    expect(svc.upsertShipment).not.toHaveBeenCalled();
  });

  it('⭐ solishtiruv: qo`lda — 409, cron — ulanishni olmaydi', async () => {
    const { svc } = makeService(MASTER_OFF);
    svc.reconcileIntegration = jest.fn();

    const error = await rpcError(svc.reconcileNow({ id: '5' }));
    const tick: Row = await svc.reconcileDueIntegrations(50);

    expect(error.statusCode).toBe(409);
    expect(tick.data.results).toEqual([]);
    expect(svc.reconcileIntegration).not.toHaveBeenCalled();
    expect(svc.shipmentRepo.find).not.toHaveBeenCalled();
  });

  it('⭐ tashqi so`rov darvozasi: faol ulanish topilmaydi — 404, HTTP chiqmaydi', async () => {
    const { svc } = makeService(MASTER_OFF);
    // Haqiqiy `executeExternalRequest` — barcha chiquvchi yo'llar shu yerdan.
    svc.executeExternalRequest =
      IntegrationServiceService.prototype['executeExternalRequest'];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    try {
      const error = await rpcError(
        svc.executeExternalRequest({
          slug: 'acme-cargo',
          endpoint: '/v1/orders',
          method: 'POST',
        }),
      );

      expect(error.statusCode).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('⭐ holat navbati YUBORILMAYDI va YO`QOLMAYDI — urinish sarflanmaydi', async () => {
    /**
     * Ilgari qator olinib, `findActiveBySlug` 404 bilan yiqilar, har yurishda
     * urinish sarflanar va 4-urinishda `permanently_failed` + adminlarga
     * xabar — ya'ni master o'chiq turgan ~21 daqiqada butun navbat yo'qolardi.
     */
    const { svc, queue } = makeService(MASTER_OFF);
    queue.push(queueRow());

    for (let tick = 0; tick < 5; tick++) {
      const res: Row = await svc.processPendingSyncQueue(20);
      expect(res.data).toMatchObject({ processed: 0, completed: 0 });
    }

    expect(queue[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      next_retry_at: null,
    });
    expect(svc.executeExternalRequest).not.toHaveBeenCalled();
    expect(svc.notifyAdminsAboutPermanentFailure).not.toHaveBeenCalled();
    expect(svc.syncQueueRepo.save).not.toHaveBeenCalled();
    // So'rov darajasida chiqarib tashlanadi: o'chiq ulanish qatori olinmaydi.
    const where = svc.syncQueueRepo.findOne.mock.calls[0][0].where as Row[];
    for (const branch of where) {
      expect(matchValue('5', branch.integration_id)).toBe(false);
      expect(matchValue('6', branch.integration_id)).toBe(true);
    }
  });

  it('"Navbatni hoziroq yuborish" (integration_id bilan) — navbat kutadi', async () => {
    const { svc, queue } = makeService(MASTER_OFF);
    queue.push(queueRow());

    const res: Row = await svc.processPendingSyncQueue(20, '5');

    expect(res.data).toMatchObject({ processed: 0, paused: true });
    expect(svc.syncQueueRepo.findOne).not.toHaveBeenCalled();
    expect(queue[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('poyga: master navbat yurishi o`rtasida o`chsa — qator kutadi, yiqilmaydi', async () => {
    const { svc, integration, queue } = makeService();
    queue.push(queueRow());
    // Yurish boshida faol edi, qator olingach operator o'chirdi.
    integration.is_active = false;

    const row: Row = await svc.processQueueItem(queue[0]);

    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.next_retry_at.getTime()).toBeGreaterThan(Date.now());
    expect(svc.executeExternalRequest).not.toHaveBeenCalled();
    expect(svc.writeSyncHistoryAttempt).not.toHaveBeenCalled();
  });

  it('⭐ master qayta yoqilganda to`plangan navbat yuboriladi', async () => {
    const { svc, integration, queue } = makeService(MASTER_OFF);
    queue.push(queueRow());

    await svc.processPendingSyncQueue(20);
    expect(svc.executeExternalRequest).not.toHaveBeenCalled();

    integration.is_active = true;
    const res: Row = await svc.processPendingSyncQueue(20);

    expect(res.data).toMatchObject({ processed: 1, completed: 1 });
    expect(queue[0]).toMatchObject({ status: 'completed', attempts: 1 });
  });
});
