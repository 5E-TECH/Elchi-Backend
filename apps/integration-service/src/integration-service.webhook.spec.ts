// Credential key is read at service construction — set before importing.
process.env.INTEGRATION_CREDENTIAL_SECRET =
  process.env.INTEGRATION_CREDENTIAL_SECRET ?? 'x'.repeat(40);

import { IntegrationServiceService } from './integration-service.service';
import { computeHmacSignature } from '@app/common';

// Use the REAL hmac functions (pure crypto) but stub the rest of @app/common
// so we don't drag in TypeORM entity metadata.
jest.mock('@app/common', () => {
  const hmac = jest.requireActual('@app/common/webhook/hmac');
  return {
    verifyHmacSignature: hmac.verifyHmacSignature,
    computeHmacSignature: hmac.computeHmacSignature,
    ActivityAction: { WEBHOOK_RECEIVED: 'webhook_received' },
    ActivityLogService: class {},
    Order_status: {},
  };
});

jest.mock('./entities/external-integration.entity', () => ({
  ExternalIntegration: class ExternalIntegration {},
}));
jest.mock('./entities/sync-queue.entity', () => ({
  SyncQueue: class SyncQueue {},
}));
jest.mock('./entities/sync-history.entity', () => ({
  SyncHistory: class SyncHistory {},
}));
jest.mock('./entities/provider-webhook-log.entity', () => ({
  ProviderWebhookLog: class ProviderWebhookLog {},
}));
jest.mock('./entities/provider-shipment.entity', () => ({
  ProviderShipment: class ProviderShipment {},
}));

const SECRET = 'provider-shared-secret';
const BODY = JSON.stringify({ event: 'package.delivered', order_id: '1001' });

function makeService(integration: Record<string, unknown> | null) {
  const integrationRepo: any = {
    findOne: jest.fn().mockResolvedValue(integration),
  };
  const webhookLogRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((dto: any) => dto),
    save: jest.fn(async (e: any) => ({ id: 'log1', ...e })),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const syncQueueRepo: any = {};
  const syncHistoryRepo: any = {};
  const shipmentRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    findAndCount: jest.fn(),
    create: jest.fn((dto: any) => ({ ...dto })),
    save: jest.fn(async (e: any) => ({ id: 'shp1', ...e })),
  };
  const activityLog: any = { log: jest.fn().mockResolvedValue(undefined) };
  const noClient: any = {};

  const service = new IntegrationServiceService(
    integrationRepo,
    syncQueueRepo,
    syncHistoryRepo,
    webhookLogRepo,
    shipmentRepo,
    activityLog,
    noClient,
    noClient,
    noClient,
    noClient,
  );
  return { service, integrationRepo, webhookLogRepo, shipmentRepo, activityLog };
}

function baseIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: '5',
    slug: 'acme-cargo',
    isDeleted: false,
    webhook_secret: SECRET, // plaintext → decryptCredential returns as-is
    webhook_secret_previous: null,
    webhook_signature_header: 'x-signature',
    webhook_signature_prefix: null,
    webhook_algorithm: 'sha256',
    webhook_id_header: 'x-delivery-id',
    ...overrides,
  };
}

function bodyToInput(
  slug: string,
  body: string,
  headers: Record<string, string>,
) {
  return {
    slug,
    raw_body_base64: Buffer.from(body, 'utf8').toString('base64'),
    headers,
  };
}

describe('IntegrationServiceService.receiveWebhook', () => {
  it('accepts a correctly signed webhook and logs it', async () => {
    const { service, webhookLogRepo, activityLog } =
      makeService(baseIntegration());
    const sig = computeHmacSignature(BODY, SECRET);

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-signature': sig,
        'x-delivery-id': 'evt_1',
      }),
    );

    expect(res).toMatchObject({ ok: true, code: 200, reason: 'accepted' });
    expect(webhookLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ signature_valid: true, status: 'verified' }),
    );
    expect(activityLog.log).toHaveBeenCalled();
  });

  it('rejects a tampered body (signature mismatch)', async () => {
    const { service, webhookLogRepo } = makeService(baseIntegration());
    const sig = computeHmacSignature(BODY, SECRET);
    const tampered = BODY.replace('1001', '9999');

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', tampered, { 'x-signature': sig }),
    );

    expect(res).toMatchObject({
      ok: false,
      code: 401,
      reason: 'invalid_signature',
    });
    expect(webhookLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ signature_valid: false, status: 'rejected' }),
    );
  });

  it('rejects an unknown provider slug', async () => {
    const { service, webhookLogRepo } = makeService(null);

    const res = await service.receiveWebhook(
      bodyToInput('does-not-exist', BODY, { 'x-signature': 'whatever' }),
    );

    expect(res).toMatchObject({
      ok: false,
      code: 401,
      reason: 'unknown_provider',
    });
    expect(webhookLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'rejected',
        error: 'integration not found',
      }),
    );
  });

  it('rejects when no webhook secret is configured', async () => {
    const { service } = makeService(baseIntegration({ webhook_secret: null }));

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, { 'x-signature': 'sig' }),
    );

    expect(res).toMatchObject({
      ok: false,
      code: 401,
      reason: 'not_configured',
    });
  });

  it('treats a duplicate delivery_id as an idempotent replay', async () => {
    const { service, webhookLogRepo } = makeService(baseIntegration());
    webhookLogRepo.findOne.mockResolvedValueOnce({ id: 'existing' });
    const sig = computeHmacSignature(BODY, SECRET);

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-signature': sig,
        'x-delivery-id': 'evt_1',
      }),
    );

    expect(res).toMatchObject({ ok: true, reason: 'duplicate', replay: true });
    // No new log written for the replay
    expect(webhookLogRepo.save).not.toHaveBeenCalled();
  });

  it('accepts a signature signed with the previous secret during rotation', async () => {
    const { service } = makeService(
      baseIntegration({
        webhook_secret: 'new-secret',
        webhook_secret_previous: 'old-secret',
      }),
    );
    const sig = computeHmacSignature(BODY, 'old-secret');

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-signature': sig,
        'x-delivery-id': 'evt_2',
      }),
    );

    expect(res).toMatchObject({ ok: true, reason: 'accepted' });
  });

  it('honours a custom signature header and prefix', async () => {
    const { service } = makeService(
      baseIntegration({
        webhook_signature_header: 'x-acme-sign',
        webhook_signature_prefix: 'sha256=',
      }),
    );
    const sig = computeHmacSignature(BODY, SECRET);

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-acme-sign': `sha256=${sig}`,
        'x-delivery-id': 'evt_3',
      }),
    );

    expect(res).toMatchObject({ ok: true, reason: 'accepted' });
  });

  it('extracts the event type from the JSON body', async () => {
    const { service, webhookLogRepo } = makeService(baseIntegration());
    const sig = computeHmacSignature(BODY, SECRET);

    await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-signature': sig,
        'x-delivery-id': 'evt_4',
      }),
    );

    expect(webhookLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'package.delivered' }),
    );
  });
});

describe('IntegrationServiceService provider shipments', () => {
  it('creates a shipment on first upsert', async () => {
    const { service, shipmentRepo } = makeService(baseIntegration());
    shipmentRepo.findOne.mockResolvedValueOnce(null);

    const res = await service.upsertShipment({
      order_id: '1001',
      integration_id: '5',
      provider_slug: 'acme-cargo',
      external_ref: 'ACME-9',
      tracking_number: 'TRK-9',
      provider_status: 'CREATED',
    });

    expect(res.statusCode).toBe(200);
    expect(shipmentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '1001',
        external_ref: 'ACME-9',
        tracking_number: 'TRK-9',
        provider_status: 'CREATED',
      }),
    );
  });

  it('updates the existing shipment row (idempotent on order_id)', async () => {
    const { service, shipmentRepo } = makeService(baseIntegration());
    const existing = {
      id: 'shp1',
      order_id: '1001',
      integration_id: '5',
      send_attempts: 1,
      external_ref: 'ACME-9',
    };
    shipmentRepo.findOne.mockResolvedValueOnce(existing);

    await service.upsertShipment({
      order_id: '1001',
      integration_id: '5',
      provider_status: 'DELIVERED',
      increment_attempt: true,
    });

    const saved = shipmentRepo.save.mock.calls[0][0];
    expect(saved.id).toBe('shp1'); // same row, not a new one
    expect(saved.provider_status).toBe('DELIVERED');
    expect(saved.send_attempts).toBe(2); // incremented
    expect(saved.external_ref).toBe('ACME-9'); // untouched field preserved
  });

  it('finds a shipment by external_ref, falling back to tracking_number', async () => {
    const { service, shipmentRepo } = makeService(baseIntegration());
    shipmentRepo.findOne
      .mockResolvedValueOnce(null) // external_ref miss
      .mockResolvedValueOnce({ id: 'shp1', tracking_number: 'TRK-9' }); // tracking hit

    const found = await service.findShipmentByRef({
      external_ref: 'missing',
      tracking_number: 'TRK-9',
    });
    expect(found).toMatchObject({ id: 'shp1' });
  });

  describe('mapProviderStatus', () => {
    const integration = {
      inbound_status_mapping: {
        DELIVERED: { status: 'sold', action: 'sell' },
        CANCELLED: { status: 'cancelled', action: 'cancel' },
        IN_TRANSIT: { status: 'waiting' },
      },
    } as any;

    it('maps a known terminal status to internal status + action', () => {
      const { service } = makeService(baseIntegration());
      expect(service.mapProviderStatus(integration, 'DELIVERED')).toEqual({
        status: 'sold',
        action: 'sell',
      });
    });

    it('maps an intermediate status with no action', () => {
      const { service } = makeService(baseIntegration());
      expect(service.mapProviderStatus(integration, 'IN_TRANSIT')).toEqual({
        status: 'waiting',
      });
    });

    it('is case-insensitive on the provider code', () => {
      const { service } = makeService(baseIntegration());
      expect(service.mapProviderStatus(integration, 'delivered')).toEqual({
        status: 'sold',
        action: 'sell',
      });
    });

    it('returns null for an unmapped status', () => {
      const { service } = makeService(baseIntegration());
      expect(service.mapProviderStatus(integration, 'WEIRD')).toBeNull();
    });
  });
});

describe('IntegrationServiceService webhook → shipment status (D3)', () => {
  const PAYLOAD = JSON.stringify({
    event: 'package.delivered',
    data: { order_id: 'ACME-9', tracking: 'TRK-9', status: { code: 'DELIVERED' } },
  });

  function trackingIntegration(overrides: Record<string, unknown> = {}) {
    return baseIntegration({
      webhook_payload_paths: {
        external_ref: 'data.order_id',
        tracking_number: 'data.tracking',
        status: 'data.status.code',
        event: 'event',
      },
      inbound_status_mapping: {
        DELIVERED: { status: 'sold', action: 'sell' },
        IN_TRANSIT: { status: 'waiting' },
      },
      ...overrides,
    });
  }

  it('maps the provider status and updates the shipment', async () => {
    const { service, shipmentRepo } = makeService(trackingIntegration());
    const shipment = {
      id: 'shp1',
      order_id: '1001',
      integration_id: '5',
      internal_status: 'waiting',
      send_attempts: 0,
    };
    // findShipmentByRef (external_ref hit) + upsert lookup both return it
    shipmentRepo.findOne.mockResolvedValue(shipment);

    const sig = computeHmacSignature(PAYLOAD, SECRET);
    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', PAYLOAD, {
        'x-signature': sig,
        'x-delivery-id': 'd1',
      }),
    );

    expect(res.shipment).toMatchObject({
      outcome: 'updated',
      internal_status: 'sold',
      action: 'sell',
      order_id: '1001',
    });
    expect(shipmentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ internal_status: 'sold', provider_status: 'DELIVERED' }),
    );
  });

  it('is idempotent when the internal status is unchanged', async () => {
    const { service, shipmentRepo } = makeService(trackingIntegration());
    const shipment = {
      id: 'shp1',
      order_id: '1001',
      integration_id: '5',
      internal_status: 'sold', // already sold
      send_attempts: 0,
    };
    shipmentRepo.findOne.mockResolvedValue(shipment);

    const sig = computeHmacSignature(PAYLOAD, SECRET);
    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', PAYLOAD, {
        'x-signature': sig,
        'x-delivery-id': 'd2',
      }),
    );

    expect(res.shipment).toMatchObject({ outcome: 'unchanged' });
  });

  it('reports no_shipment when the order has no shipment row', async () => {
    const { service, shipmentRepo } = makeService(trackingIntegration());
    shipmentRepo.findOne.mockResolvedValue(null); // no shipment found

    const sig = computeHmacSignature(PAYLOAD, SECRET);
    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', PAYLOAD, {
        'x-signature': sig,
        'x-delivery-id': 'd3',
      }),
    );

    expect(res.shipment).toMatchObject({ outcome: 'no_shipment' });
    // Webhook still succeeds (200) — provider gets an ack
    expect(res.ok).toBe(true);
  });

  it('records the raw status but reports unmapped for an unknown provider status', async () => {
    const { service, shipmentRepo } = makeService(trackingIntegration());
    const shipment = {
      id: 'shp1',
      order_id: '1001',
      integration_id: '5',
      internal_status: 'waiting',
      send_attempts: 0,
    };
    shipmentRepo.findOne.mockResolvedValue(shipment);

    const body = JSON.stringify({
      event: 'package.weird',
      data: { order_id: 'ACME-9', tracking: 'TRK-9', status: { code: 'WAREHOUSE_X' } },
    });
    const sig = computeHmacSignature(body, SECRET);
    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', body, { 'x-signature': sig, 'x-delivery-id': 'd4' }),
    );

    expect(res.shipment).toMatchObject({ outcome: 'unmapped' });
    expect(shipmentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ provider_status: 'WAREHOUSE_X' }),
    );
  });

  it('reports no_paths when the integration has no payload paths configured', async () => {
    const { service } = makeService(baseIntegration()); // no webhook_payload_paths
    const sig = computeHmacSignature(PAYLOAD, SECRET);
    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', PAYLOAD, {
        'x-signature': sig,
        'x-delivery-id': 'd5',
      }),
    );

    expect(res.shipment).toMatchObject({ outcome: 'no_paths' });
  });
});

describe('IntegrationServiceService.dispatchShipment (D4)', () => {
  function dispatchIntegration(overrides: Record<string, unknown> = {}) {
    return baseIntegration({
      dispatch_config: {
        endpoint: '/orders',
        method: 'POST',
        use_auth: true,
        body_template: {
          external_id: '{{order_id}}',
          phone: '{{customer_phone}}',
          cod_amount: '{{total_price}}',
        },
        response_paths: {
          external_ref: 'data.order_id',
          tracking_number: 'data.tracking_number',
          status: 'data.status',
        },
      },
      ...overrides,
    });
  }

  it('creates a shipment at the provider and records refs', async () => {
    const { service, shipmentRepo } = makeService(dispatchIntegration());
    shipmentRepo.findOne.mockResolvedValue(null); // new shipment

    jest.spyOn(service as any, 'executeExternalRequest').mockResolvedValue({
      data: {
        raw: {
          data: { order_id: 'ACME-77', tracking_number: 'TRK-77', status: 'CREATED' },
        },
      },
    });

    const res = await service.dispatchShipment({
      slug: 'acme-cargo',
      order_id: '1001',
      context: { customer_phone: '+998901112233', total_price: '150000' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.data).toMatchObject({
      order_id: '1001',
      external_ref: 'ACME-77',
      tracking_number: 'TRK-77',
    });
    expect(shipmentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        external_ref: 'ACME-77',
        tracking_number: 'TRK-77',
        provider_status: 'CREATED',
        send_attempts: 1,
      }),
    );
  });

  it('records last_error and bumps attempts when the provider call fails', async () => {
    const { service, shipmentRepo } = makeService(dispatchIntegration());
    shipmentRepo.findOne.mockResolvedValue(null);

    jest
      .spyOn(service as any, 'executeExternalRequest')
      .mockRejectedValue(new Error('provider 500'));

    await expect(
      service.dispatchShipment({ slug: 'acme-cargo', order_id: '1001' }),
    ).rejects.toThrow('provider 500');

    expect(shipmentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ last_error: 'provider 500', send_attempts: 1 }),
    );
  });

  it('rejects when dispatch_config has no endpoint', async () => {
    const { service } = makeService(baseIntegration()); // no dispatch_config

    await expect(
      service.dispatchShipment({ slug: 'acme-cargo', order_id: '1001' }),
    ).rejects.toBeDefined();
  });
});

describe('IntegrationServiceService webhook → order terminal action (D3b)', () => {
  const PAYLOAD = JSON.stringify({
    event: 'package.delivered',
    data: { order_id: 'ACME-9', tracking: 'TRK-9', status: { code: 'DELIVERED' } },
  });

  function trackingIntegration() {
    return baseIntegration({
      webhook_payload_paths: {
        external_ref: 'data.order_id',
        tracking_number: 'data.tracking',
        status: 'data.status.code',
        event: 'event',
      },
      inbound_status_mapping: {
        DELIVERED: { status: 'sold', action: 'sell' },
      },
    });
  }

  it('calls order.provider.mark with the terminal action', async () => {
    const { service, shipmentRepo } = makeService(trackingIntegration());
    shipmentRepo.findOne.mockResolvedValue({
      id: 'shp1',
      order_id: '1001',
      integration_id: '5',
      internal_status: 'waiting',
      external_ref: 'ACME-9',
      send_attempts: 0,
    });
    const rmqSpy = jest
      .spyOn(service as any, 'rmqRequest')
      .mockResolvedValue({ statusCode: 200 });

    const sig = computeHmacSignature(PAYLOAD, SECRET);
    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', PAYLOAD, { 'x-signature': sig, 'x-delivery-id': 'o1' }),
    );

    expect(res.ok).toBe(true);
    expect(rmqSpy).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.provider.mark' },
      expect.objectContaining({
        order_id: '1001',
        action: 'sell',
        provider_slug: 'acme-cargo',
      }),
    );
  });

  it('still returns 200 when order.provider.mark fails', async () => {
    const { service, shipmentRepo } = makeService(trackingIntegration());
    shipmentRepo.findOne.mockResolvedValue({
      id: 'shp1',
      order_id: '1001',
      integration_id: '5',
      internal_status: 'waiting',
      external_ref: 'ACME-9',
      send_attempts: 0,
    });
    jest
      .spyOn(service as any, 'rmqRequest')
      .mockRejectedValue(new Error('order-service down'));

    const sig = computeHmacSignature(PAYLOAD, SECRET);
    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', PAYLOAD, { 'x-signature': sig, 'x-delivery-id': 'o2' }),
    );

    expect(res.ok).toBe(true);
    expect(res.shipment).toMatchObject({ outcome: 'updated', action: 'sell' });
  });
});
