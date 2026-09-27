import { Logger } from '@nestjs/common';
import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { of } from 'rxjs';
import { OrderServiceController } from './order-service.controller';
import { OrderLookupService } from './lookup/order-lookup.service';
import { AiPreviewService } from './ai/ai-preview.service';
import { ProductResolverService } from './ai/product-resolver.service';
import type { AiResolvePreviewRequest } from './ai/ai-preview.types';

/** Test dubli — kerakli tipga keltiriladi (faqat ishlatilgan metodlar bor). */
const stub = <T>(value: unknown): T => value as T;

/**
 * fPre2MRr — `order.ai_resolve_preview` RMQ handleri.
 *
 * #10: preview oqimi `OrderLookupService.resolveDistrictId` (zaxira bilan) va
 *      `getDefaultDistrictId` ni HECH QACHON chaqirmaydi — zaxira jadvaldagi
 *      birinchi tuman (`ORDER BY`siz `limit: 1`), ya'ni mos kelmagan buyurtma
 *      jimgina boshqa viloyatga ketardi.
 * #12: bir xil `request_id` bilan ikki marta — executeIdempotent bitta natija
 *      qaytaradi, `resolve` ikkinchi marta chaqirilmaydi.
 */

const MARKET = '121';

const request = (
  over: Partial<AiResolvePreviewRequest> = {},
): AiResolvePreviewRequest => ({
  raw_orders: [
    {
      customer_name: 'Aziz',
      phone_number: '900112233',
      extra_number: null,
      region_name: 'Toshkent',
      district_name: 'Nomalum joy',
      address: null,
      full_address: 'Toshkent Nomalum joy',
      items: [{ name: 'blender', quantity: 1 }],
      total_price: 320000,
      comment: null,
      where_deliver: null,
      is_replacement: false,
      operator: '#sevinch',
    },
  ],
  market_id: MARKET,
  requester: { id: '7', roles: ['market'] },
  request_id: 'preview-req-1',
  trace_id: 'trace-1',
  draft_id: 'draft-1',
  deadline_at: Date.now() + 25_000,
  ...over,
});

function controllerWith(
  idempotencyService: Record<string, jest.Mock>,
  aiPreview: { resolve: jest.Mock },
) {
  const rmqService = {
    ack: jest.fn(),
    nack: jest.fn(),
    nackForError: jest.fn(),
  };
  const controller = new OrderServiceController(
    stub(rmqService),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub(idempotencyService),
    stub(aiPreview),
  );
  return { controller, rmqService };
}

describe('order.ai_resolve_preview handler', () => {
  it("naqsh AYNAN { cmd: 'order.ai_resolve_preview' }", () => {
    const handler = Object.getOwnPropertyDescriptor(
      OrderServiceController.prototype,
      'aiResolvePreview',
    )?.value as object;
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'order.ai_resolve_preview' },
    ]);
  });

  it('#12 bir xil request_id — ikkinchisi keshdan, resolve 1 marta', async () => {
    const first = { previews: [{ index: 0, ready: false }] };
    const idem = {
      tryAcquire: jest
        .fn()
        .mockResolvedValueOnce({ status: 'new' })
        .mockResolvedValueOnce({ status: 'cached', response: first }),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const aiPreview = { resolve: jest.fn().mockResolvedValue(first) };
    const { controller, rmqService } = controllerWith(idem, aiPreview);
    const ctx = stub<RmqContext>({});
    const data = request();

    const r1 = await controller.aiResolvePreview(data, ctx);
    const r2 = await controller.aiResolvePreview(data, ctx);

    expect(r1).toEqual(first);
    expect(r2).toEqual(first);
    expect(aiPreview.resolve).toHaveBeenCalledTimes(1);
    expect(aiPreview.resolve).toHaveBeenCalledWith(data);
    expect(idem.tryAcquire).toHaveBeenNthCalledWith(
      1,
      'order.ai_resolve_preview:preview-req-1',
      'order.ai_resolve_preview',
      undefined,
      undefined,
    );
    expect(idem.markCompleted).toHaveBeenCalledWith(
      'order.ai_resolve_preview:preview-req-1',
      first,
    );
    expect(rmqService.ack).toHaveBeenCalledTimes(2);
  });

  it('#12 IdempotencyService keshdan qaytarsa resolve UMUMAN chaqirilmaydi', async () => {
    const cached = { previews: [] };
    const idem = {
      tryAcquire: jest
        .fn()
        .mockResolvedValue({ status: 'cached', response: cached }),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const aiPreview = { resolve: jest.fn() };
    const { controller } = controllerWith(idem, aiPreview);

    await expect(
      controller.aiResolvePreview(request(), stub({})),
    ).resolves.toBe(cached);
    expect(aiPreview.resolve).not.toHaveBeenCalled();
    expect(idem.markCompleted).not.toHaveBeenCalled();
  });
});

describe('#10 zaxirali resolveDistrictId bu oqimdan CHAQIRILMAYDI', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('AiPreviewService OrderLookupService ni inject qilmaydi', () => {
    const deps = (Reflect.getMetadata('design:paramtypes', AiPreviewService) ??
      []) as unknown[];
    expect(deps).toContain(ProductResolverService);
    expect(deps).not.toContain(OrderLookupService);
  });

  it('tuman aniqlanmagan partiyada ham resolveDistrictId/getDefaultDistrictId 0 marta', async () => {
    const resolveDistrictId = jest.spyOn(
      OrderLookupService.prototype,
      'resolveDistrictId',
    );
    const resolveDistrictIdOrNull = jest.spyOn(
      OrderLookupService.prototype,
      'resolveDistrictIdOrNull',
    );
    const getDefaultDistrictId = jest.spyOn(
      OrderLookupService.prototype,
      'getDefaultDistrictId',
    );
    try {
      const catalogClient = {
        send: jest.fn(() =>
          of({ data: [{ id: '12', name: 'Blender', user_id: MARKET }] }),
        ),
      };
      const logisticsClient = {
        send: jest.fn((_p: unknown, payload: { items: unknown[] }) =>
          of({
            statusCode: 200,
            data: payload.items.map(() => ({
              region_id: null,
              district_id: null,
              region_name: null,
              district_name: null,
              region_given: false,
              candidates: [],
              reason: 'region_ambiguous',
            })),
          }),
        ),
      };
      const identityClient = {
        send: jest.fn(() => of({ data: { default_tariff: 'center' } })),
      };
      const resolver = new ProductResolverService(stub(catalogClient), {
        pick: jest.fn().mockResolvedValue(null),
      });
      const svc = new AiPreviewService(
        resolver,
        stub(logisticsClient),
        stub(identityClient),
        stub({ prunePattern: jest.fn().mockResolvedValue(0) }),
      );

      const { previews } = await svc.resolve(request());

      expect(previews).toHaveLength(1);
      expect(previews[0].district_id).toBeNull();
      expect(previews[0].issues).toContain('district_missing');
      expect(resolveDistrictId).toHaveBeenCalledTimes(0);
      expect(resolveDistrictIdOrNull).toHaveBeenCalledTimes(0);
      expect(getDefaultDistrictId).toHaveBeenCalledTimes(0);
    } finally {
      resolveDistrictId.mockRestore();
      resolveDistrictIdOrNull.mockRestore();
      getDefaultDistrictId.mockRestore();
    }
  });
});
