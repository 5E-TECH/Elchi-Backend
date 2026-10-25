import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * LFNLeSpu (BG4) — `GET /orders?cancel_stage=` (va `GET /orders/export/excel`):
 *   - `courier,in_transit,branch,hq,market` (vergul / massiv, harf farqsiz) →
 *     order-service `findAll` ga `cancel_stages` (BG1 `return_stage` bilan bir
 *     xil SQL ta'rif, OR);
 *   - noto'g'ri qiymat — 400, order-service'ga so'rov yo'q;
 *   - rol doirasi o'zgarmaydi (market — o'z id, filial — o'z filiali, kuryer —
 *     o'zi), `cancel_stage` bilan inventar/kuryer-bekor tab rejimi yoqilmaydi.
 */
type Resolver = (
  filters: Record<string, unknown>,
  user: unknown,
) => Promise<{
  kind: string;
  query?: Record<string, unknown>;
  filters?: Record<string, unknown>;
}>;

function makeController() {
  const orderClient = { send: jest.fn(() => of({ data: [], total: 0 })) };
  const controller = new OrderGatewayController(
    orderClient as never,
    { send: jest.fn(() => of({ data: null })) } as never,
    { send: jest.fn(() => of({})) } as never,
    { send: jest.fn(() => of({ data: null })) } as never,
  );
  const internals = controller as unknown as {
    resolveOrderListRequest: Resolver;
    resolveBranchAssignment: jest.Mock;
    isHqRegistrator: jest.Mock;
  };
  internals.resolveBranchAssignment = jest
    .fn()
    .mockResolvedValue({ branch_id: '13', role: 'MANAGER' });
  internals.isHqRegistrator = jest.fn().mockResolvedValue(false);
  const resolve: Resolver = internals.resolveOrderListRequest.bind(controller);
  return { controller, orderClient, resolve };
}

const admin = { sub: '2', roles: ['admin'] };
const market = { sub: '37', roles: ['market'] };
const manager = { sub: '25', roles: ['manager'] };
const courier = { sub: '26', roles: ['courier'] };

describe('LFNLeSpu (BG4) — GET /orders cancel_stage filtri', () => {
  it('⭐ vergulli ro`yxat / massiv → cancel_stages (kichik harf, takrorsiz); berilmasa — kalit yo`q', async () => {
    const { resolve } = makeController();
    await expect(
      resolve({ cancel_stage: 'branch, HQ,branch' }, admin),
    ).resolves.toMatchObject({
      kind: 'query',
      query: { cancel_stages: ['branch', 'hq'] },
    });
    await expect(
      resolve({ cancel_stage: ['courier', 'in_transit,market'] }, admin),
    ).resolves.toMatchObject({
      query: { cancel_stages: ['courier', 'in_transit', 'market'] },
    });
    const none = await resolve({}, admin);
    expect(none.query).not.toHaveProperty('cancel_stages');
    const empty = await resolve({ cancel_stage: '' }, admin);
    expect(empty.query).not.toHaveProperty('cancel_stages');
  });

  it('⭐ noto`g`ri qiymat — 400, order-service`ga so`rov yo`q (handler ham)', async () => {
    const { controller, orderClient, resolve } = makeController();
    await expect(
      resolve({ cancel_stage: 'hq,yolda' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(resolve({ cancel_stage: 'hq,yolda' }, admin)).rejects.toThrow(
      /cancel_stage noto'g'ri: yolda/,
    );
    // GET /orders handler: `cancel_stage` — 23-parametr (oxirgi).
    const args: unknown[] = Array.from({ length: 22 }, () => undefined);
    args[15] = { user: admin };
    args.push('warehouse');
    await expect(
      (
        controller.findAll as unknown as (...a: unknown[]) => Promise<unknown>
      ).apply(controller, args),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it('⭐ handler → order-service find_all_enriched: cancel_stages so`rovda', async () => {
    const { controller, orderClient } = makeController();
    const args: unknown[] = Array.from({ length: 22 }, () => undefined);
    args[15] = { user: admin };
    args.push('in_transit');
    await (
      controller.findAll as unknown as (...a: unknown[]) => Promise<unknown>
    ).apply(controller, args);
    const sent = (orderClient.send.mock.calls as unknown[][]).find(
      (call) =>
        (call[0] as { cmd?: string })?.cmd === 'order.find_all_enriched',
    );
    expect(
      (sent?.[1] as { query: Record<string, unknown> }).query,
    ).toMatchObject({ cancel_stages: ['in_transit'] });
  });

  it('market — doira o`z id`si bilan qoladi, boshqa market_id — 400', async () => {
    const { resolve } = makeController();
    await expect(
      resolve({ cancel_stage: 'in_transit,market' }, market),
    ).resolves.toMatchObject({
      kind: 'query',
      query: { market_id: '37', cancel_stages: ['in_transit', 'market'] },
    });
    await expect(
      resolve({ cancel_stage: 'hq', market_id: '99' }, market),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('⭐ filial xodimi: status=cancelled + cancel_stage — o`z filiali, inventar qotirmasi (holder BRANCH, pochtasiz) YO`Q', async () => {
    const { resolve } = makeController();
    const withStage = await resolve(
      { status: 'cancelled', cancel_stage: 'in_transit,branch' },
      manager,
    );
    expect(withStage).toMatchObject({
      kind: 'query',
      query: {
        branch_id: '13',
        status: ['cancelled'],
        cancel_stages: ['in_transit', 'branch'],
      },
    });
    expect(withStage.query?.holder_type).toBeUndefined();
    expect(withStage.query?.canceled_post_unassigned).toBeUndefined();

    // Regressiya: cancel_stage'siz — avvalgi inventar tabi o'zgarmagan.
    const inventory = await resolve({ status: 'cancelled' }, manager);
    expect(inventory.query).toMatchObject({
      branch_id: '13',
      holder_type: 'BRANCH',
      canceled_post_unassigned: true,
    });
  });

  it('kuryer: status=cancelled + cancel_stage — o`z buyurtmalari (courier_ids=[me]), alohida bekor-tab yo`li emas', async () => {
    const { resolve } = makeController();
    await expect(
      resolve({ status: 'cancelled', cancel_stage: 'courier' }, courier),
    ).resolves.toMatchObject({
      kind: 'query',
      query: { courier_ids: ['26'], cancel_stages: ['courier'] },
    });
    // Regressiya: cancel_stage'siz — kuryer bekor tabi avvalgidek.
    await expect(
      resolve({ status: 'cancelled' }, courier),
    ).resolves.toMatchObject({ kind: 'courier_cancelled' });
  });

  it('eksport (GET /orders/export/excel) ham cancel_stage`ni bir xil resolver`ga uzatadi', async () => {
    const { controller } = makeController();
    const spy = jest
      .spyOn(
        controller as unknown as { resolveOrderListRequest: Resolver },
        'resolveOrderListRequest',
      )
      .mockRejectedValue(new Error('__STOP__'));
    const args: unknown[] = [{} as never, { user: admin }];
    args.push(...Array.from({ length: 18 }, () => undefined));
    args.push('hq');
    await expect(
      (
        controller.exportOrdersExcel as unknown as (
          ...a: unknown[]
        ) => Promise<unknown>
      ).apply(controller, args),
    ).rejects.toThrow('__STOP__');
    expect(spy.mock.calls[0][0]).toMatchObject({ cancel_stage: 'hq' });
  });
});
