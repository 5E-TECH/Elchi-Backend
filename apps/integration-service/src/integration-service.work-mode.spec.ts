/**
 * ULANISH ISH REJIMI VA WEBHOOK KO'RGICHI.
 *
 *   DOZ6dtJn — solishtiruvchi: ochiq posilka holati tashuvchidan so'raladi,
 *              farq bo'lsa webhook bilan AYNI yo'l orqali qo'llanadi;
 *              tashuvchi javobidagi summa daftarga TEGMAYDI; master o'chiq
 *              bo'lsa hech narsa ishlamaydi; qulf band bo'lsa 409.
 *   Xd88lHGq — bitta webhook yozuvi maskalangan payload bilan (xom tana hech
 *              qachon), maskasiz faqat superadmin + jurnal; qayta ishlash
 *              faqat imzosi to'g'ri va hali qo'llanmagan yozuv uchun, ikki
 *              parallel bosish ikki marta qo'llamaydi.
 */
import { RpcException } from '@nestjs/microservices';
import { IntegrationServiceService } from './integration-service.service';

type Row = Record<string, any>;

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

const INTEGRATION = {
  id: '5',
  slug: 'acme-cargo',
  is_active: true,
  webhook_enabled: true,
  reconcile_enabled: true,
  status_sync_config: {
    status_query: {
      endpoint: '/shipments/{{external_ref}}',
      method: 'GET',
      status_path: 'data.status',
    },
  },
};

function makeService(over: { integration?: Row; lockAcquired?: boolean } = {}) {
  const integration = { ...INTEGRATION, ...(over.integration ?? {}) };
  const svc = Object.create(IntegrationServiceService.prototype) as Row;
  const queryRunner = {
    connect: jest.fn(),
    release: jest.fn(),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('pg_try_advisory_lock')
          ? [{ acquired: over.lockAcquired ?? true }]
          : [],
      ),
    ),
  };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.integrationRepo = {
    findOne: jest.fn().mockResolvedValue(integration),
    find: jest.fn().mockResolvedValue([integration]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: {
      connection: { createQueryRunner: jest.fn(() => queryRunner) },
    },
  };
  svc.shipmentRepo = { find: jest.fn().mockResolvedValue([]) };
  svc.webhookLogRepo = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  svc.activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  // `Row` — jest mock'lari metodlar sifatida emas, maydon sifatida o'qiladi
  // (unbound-method). Tekshirilayotgan metodlar prototipdan keladi.
  return { svc, integration, queryRunner };
}

describe('DOZ6dtJn — solishtiruvchi', () => {
  const shipments = [
    { order_id: '101', external_ref: 'EXT-1', internal_status: 'new' },
    { order_id: '102', external_ref: 'EXT-2', internal_status: null },
    { order_id: '103', external_ref: null, tracking_number: null },
  ];

  it('⭐ ochiq posilkalar so`raladi, holat AYNI yo`l bilan qo`llanadi', async () => {
    const { svc } = makeService();
    svc.shipmentRepo.find.mockResolvedValue(shipments);
    svc.executeExternalRequest = jest.fn((input: Row) =>
      Promise.resolve({
        data: {
          raw: {
            data: {
              status: input.endpoint.includes('EXT-1')
                ? 'delivered'
                : 'in_transit',
              // ⚠️ Tashuvchi summasi — daftarga TEGMASLIGI kerak.
              cod_collected: 999999,
            },
          },
        },
      }),
    );
    svc.applyProviderStatusToShipment = jest.fn((_i: Row, shipment: Row) =>
      Promise.resolve({
        outcome: shipment.order_id === '101' ? 'updated' : 'unchanged',
      }),
    );

    const res: any = await svc.reconcileNow({ id: '5' });

    expect(res.data).toMatchObject({
      checked: 2,
      applied: 1,
      unchanged: 1,
      skipped: 1,
      failed: 0,
    });
    expect(svc.executeExternalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'acme-cargo',
        method: 'GET',
        endpoint: '/shipments/EXT-1',
      }),
    );
    // Faqat holat satri uzatiladi — summa emas.
    const applyArgs = svc.applyProviderStatusToShipment.mock.calls.map(
      (call: unknown[]) => call.slice(2),
    );
    expect(applyArgs).toEqual(
      expect.arrayContaining([
        ['delivered', null],
        ['in_transit', null],
      ]),
    );
    expect(
      JSON.stringify(svc.applyProviderStatusToShipment.mock.calls),
    ).not.toContain('999999');
    expect(svc.integrationRepo.update).toHaveBeenCalledWith(
      { id: '5' },
      { last_reconcile_at: expect.any(Date) },
    );
  });

  it('yakuniy holatdagi posilka so`rovga tushmaydi (WHERE)', async () => {
    const { svc } = makeService();
    svc.executeExternalRequest = jest.fn();

    await svc.reconcileNow({ id: '5' });

    const where = svc.shipmentRepo.find.mock.calls[0][0].where;
    expect(where).toHaveLength(2);
    expect(where[0]).toMatchObject({ integration_id: '5', isDeleted: false });
    expect(JSON.stringify(where[1].internal_status)).toContain('sold');
  });

  it('⭐ master o`chiq — 409, hech narsa so`ralmaydi', async () => {
    const { svc } = makeService({ integration: { is_active: false } });
    svc.executeExternalRequest = jest.fn();

    const error = await rpcError(svc.reconcileNow({ id: '5' }));

    expect(error.statusCode).toBe(409);
    expect(svc.shipmentRepo.find).not.toHaveBeenCalled();
  });

  it('status_query sozlanmagan — 400', async () => {
    const { svc } = makeService({ integration: { status_sync_config: {} } });

    const error = await rpcError(svc.reconcileNow({ id: '5' }));

    expect(error.statusCode).toBe(400);
  });

  it('⭐ qulf band (boshqa replika) — 409, posilkalar o`qilmaydi', async () => {
    const { svc } = makeService({ lockAcquired: false });

    const error = await rpcError(svc.reconcileNow({ id: '5' }));

    expect(error.statusCode).toBe(409);
    expect(svc.shipmentRepo.find).not.toHaveBeenCalled();
  });

  it('cron: reconcile_enabled va master yoqiq ulanishlar; qulf band — o`tkazib yuboriladi', async () => {
    const first = makeService();
    first.svc.reconcileIntegration = jest
      .fn()
      .mockResolvedValue({ integration_id: '5', applied: 0 });
    await first.svc.reconcileDueIntegrations(50);
    expect(first.svc.integrationRepo.find).toHaveBeenCalledWith({
      where: { is_active: true, reconcile_enabled: true, isDeleted: false },
    });
    expect(first.svc.reconcileIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: '5' }),
      50,
    );

    const busy = makeService({ lockAcquired: false });
    const res: any = await busy.svc.reconcileDueIntegrations(50);
    expect(res.data.skipped).toBe('already_running');
    expect(busy.svc.integrationRepo.find).not.toHaveBeenCalled();
  });
});

describe('Xd88lHGq — webhook yozuvi ko`rgichi', () => {
  const LOG = {
    id: '77',
    integration_id: '5',
    provider_slug: 'acme-cargo',
    delivery_id: 'evt_1',
    event_type: 'shipment.status_changed',
    signature_valid: true,
    status: 'processed',
    error: 'apply: no_shipment',
    parsed_payload: {
      shipment: { external_ref: 'EXT-1', status: 'delivered' },
      customer: { name: 'Aliyev Vali', phone: '+998901237434' },
    },
  };

  it('⭐ maskalangan payload, xom tana yo`q, qayta ishlash mumkin', async () => {
    const { svc } = makeService();
    svc.webhookLogRepo.findOne.mockResolvedValue(LOG);

    const res: any = await svc.getWebhookLogDetail({
      id: '77',
      requester: { id: '2', roles: ['admin'] },
    });

    expect(res.data.payload.customer).toEqual({
      name: 'A. V.',
      phone: '***7434',
    });
    expect(res.data.payload.shipment).toEqual(LOG.parsed_payload.shipment);
    expect(res.data).not.toHaveProperty('raw_body');
    expect(res.data).not.toHaveProperty('parsed_payload');
    expect(res.data.can_reprocess).toBe(true);
    const select = svc.webhookLogRepo.findOne.mock.calls[0][0].select;
    expect(select.raw_body).toBeUndefined();
    expect(svc.activityLog.log).not.toHaveBeenCalled();
  });

  it('⭐ maskasiz: admin — 403; superadmin — ochiladi va jurnalga yoziladi', async () => {
    const admin = makeService();
    const error = await rpcError(
      admin.svc.getWebhookLogDetail({
        id: '77',
        unmasked: true,
        requester: { id: '2', roles: ['admin'] },
      }),
    );
    expect(error.statusCode).toBe(403);

    const sa = makeService();
    sa.svc.webhookLogRepo.findOne.mockResolvedValue(LOG);
    const res: any = await sa.svc.getWebhookLogDetail({
      id: '77',
      unmasked: true,
      requester: { id: '1', roles: ['superadmin'] },
    });
    expect(res.data.payload.customer.phone).toBe('+998901237434');
    expect(sa.svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '77',
        action: 'webhook.payload.unmasked_view',
        // Xd88lHGq: kim ko'rgani ijrochi ustunlarida — prodda null edi.
        user_id: '1',
        user_role: 'superadmin',
      }),
    );
  });

  it('tana JSON bo`lmasa bo`sh modal emas — sabab qaytadi', async () => {
    const { svc } = makeService();
    svc.webhookLogRepo.findOne.mockResolvedValue({
      ...LOG,
      parsed_payload: null,
      error: 'signature invalid',
    });

    const res: any = await svc.getWebhookLogDetail({ id: '77' });

    expect(res.data.payload).toBeNull();
    expect(res.data.payload_note).toContain('JSON emas');
    expect(res.data.can_reprocess).toBe(false);
  });

  it.each([
    [{ signature_valid: false }, "Imzo noto'g'ri"],
    [{ status: 'processed', error: null }, 'Allaqachon ishlangan'],
  ])('qayta ishlash taqiqlangan %p — 409 "%s"', async (patch, reason) => {
    const { svc } = makeService();
    svc.webhookLogRepo.findOne.mockResolvedValue({ ...LOG, ...patch });
    svc.applyVerifiedWebhook = jest.fn();

    const error = await rpcError(svc.reprocessWebhookLog({ id: '77' }));

    expect(error.statusCode).toBe(409);
    expect(error.message).toContain(reason);
    expect(svc.applyVerifiedWebhook).not.toHaveBeenCalled();
  });

  it('⭐ qayta ishlash: yozuv egallanadi, AYNI yo`l bilan qo`llanadi, jurnalga yoziladi', async () => {
    const { svc } = makeService();
    svc.webhookLogRepo.findOne.mockResolvedValue(LOG);
    // `processed` + xato: birinchi (holatlar ro'yxati) shart 0, ikkinchisi 1.
    svc.webhookLogRepo.update
      .mockResolvedValueOnce({ affected: 0 })
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValue({ affected: 0 });
    svc.applyVerifiedWebhook = jest
      .fn()
      .mockResolvedValue({ ok: true, reason: 'accepted' });

    const res: any = await svc.reprocessWebhookLog({
      id: '77',
      requester: { id: '1', roles: ['superadmin'] },
    });

    expect(res.data).toMatchObject({ log_id: '77', reason: 'accepted' });
    expect(svc.webhookLogRepo.update.mock.calls[1][1]).toEqual({
      status: 'reprocessing',
    });
    expect(svc.applyVerifiedWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: '5' }),
      LOG.parsed_payload,
      '77',
      LOG.event_type,
      'evt_1',
    );
    expect(svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'webhook.reprocess',
        user_id: '1',
        user_role: 'superadmin',
      }),
    );
  });

  it('⭐ parallel ikkinchi bosish yozuvni egallay olmaydi — 409, ikki marta qo`llanmaydi', async () => {
    const { svc } = makeService();
    svc.webhookLogRepo.findOne.mockResolvedValue(LOG);
    svc.webhookLogRepo.update.mockResolvedValue({ affected: 0 });
    svc.applyVerifiedWebhook = jest.fn();

    const error = await rpcError(svc.reprocessWebhookLog({ id: '77' }));

    expect(error.statusCode).toBe(409);
    expect(svc.applyVerifiedWebhook).not.toHaveBeenCalled();
  });

  it('qo`llash yiqilsa yozuv `failed` ga qaytadi (egallangancha qolmaydi)', async () => {
    const { svc } = makeService();
    svc.webhookLogRepo.findOne.mockResolvedValue({
      ...LOG,
      status: 'verified',
      error: null,
    });
    svc.applyVerifiedWebhook = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(svc.reprocessWebhookLog({ id: '77' })).rejects.toThrow('boom');

    expect(svc.webhookLogRepo.update).toHaveBeenLastCalledWith(
      { id: '77', status: 'reprocessing' },
      expect.objectContaining({ status: 'failed', error: 'reprocess: boom' }),
    );
  });
});
