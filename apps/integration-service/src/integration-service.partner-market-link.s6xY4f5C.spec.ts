import { RpcException } from '@nestjs/microservices';
import { FindOperator } from 'typeorm';
import { of } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';

/**
 * T1 K1 (s6xY4f5C) — hamkor sotuvchilari ro'yxati va sotuvchini MAVJUD
 * Elchi marketiga bog'lash. `partner_market_refs` — xotiradagi soxta repo
 * (unique (partner_id, external_seller_id) o'chirilganlarni ham qamraydi).
 */
type Ref = {
  id: string;
  partner_id: string;
  external_seller_id: string;
  elchi_market_id: string;
  isDeleted: boolean;
  createdAt: Date;
};

const matches = (
  row: Record<string, unknown>,
  where: Record<string, unknown>,
) =>
  Object.entries(where).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      if (expected.type === 'not') return row[key] !== expected.value;
      throw new Error(`operator ${expected.type}`);
    }
    return String(row[key]) === String(expected);
  });

function refRepo(initial: Ref[] = []) {
  const rows: Ref[] = initial.map((r) => ({ ...r }));
  let seq = 100;
  const repo = {
    rows,
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
    ),
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
    ),
    create: jest.fn((x: Partial<Ref>) => x),
    save: jest.fn((x: Partial<Ref>) => {
      if (
        rows.some(
          (r) =>
            r.partner_id === x.partner_id &&
            r.external_seller_id === x.external_seller_id,
        )
      ) {
        return Promise.reject(
          Object.assign(new Error('duplicate'), { code: '23505' }),
        );
      }
      const saved = {
        id: String(++seq),
        isDeleted: false,
        createdAt: new Date(),
        ...x,
      } as Ref;
      rows.push(saved);
      return Promise.resolve(saved);
    }),
    update: jest.fn((where: Record<string, unknown>, patch: Partial<Ref>) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ affected: hit.length });
    }),
  };
  return repo;
}

/** identity: faqat FAOL `market` rolidagilar (find_by_ids xulqi). */
const MARKETS: Record<string, Record<string, unknown>> = {
  '500': {
    id: '500',
    name: 'Zamon Store',
    phone_number: '+998901234567',
    tariff_home: 30000,
    tariff_center: '20000',
  },
  '501': { id: '501', name: 'Boshqa', phone_number: null, tariff_home: 1 },
};

function build(initial: Ref[] = [], opts: { identityDown?: boolean } = {}) {
  const repo = refRepo(initial);
  const identitySend = jest.fn((pattern: { cmd: string }, payload: any) => {
    if (pattern.cmd === 'identity.market.find_by_ids') {
      if (opts.identityDown) throw new Error('down');
      return of({
        data: (payload.ids as string[])
          .map((id) => MARKETS[id])
          .filter(Boolean),
      });
    }
    return of({ data: { id: '999' } });
  });
  const log = jest.fn(() => Promise.resolve(undefined));
  const svc = Object.create(
    IntegrationServiceService.prototype,
  ) as IntegrationServiceService & Record<string, any>;
  Object.assign(svc, {
    partnerRepo: {
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          ['7', '8'].includes(String(where.id)) ? { id: where.id } : null,
        ),
      ),
    },
    partnerMarketRefRepo: repo,
    identityClient: { send: identitySend },
    activityLog: { log },
  });
  return { svc, repo, identitySend, log };
}

const SA = { id: '1', roles: ['superadmin'] };
const ref = (over: Partial<Ref>): Ref => ({
  id: '1',
  partner_id: '7',
  external_seller_id: 'shop-1',
  elchi_market_id: '500',
  isDeleted: false,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      code?: string;
    };
  }
  throw new Error('RpcException kutilgandi');
}

describe('T1 K1 — listPartnerMarkets', () => {
  it('faol qatorlar, yangi → eski; market yo`q → null; bitta find_by_ids', async () => {
    const { svc, identitySend } = build([
      ref({ id: '1', createdAt: new Date('2026-10-01T00:00:00Z') }),
      ref({
        id: '2',
        external_seller_id: 'shop-2',
        elchi_market_id: '777',
        createdAt: new Date('2026-10-03T00:00:00Z'),
      }),
      ref({ id: '3', external_seller_id: 'old', isDeleted: true }),
      ref({ id: '4', partner_id: '8', external_seller_id: 'other' }),
    ]);
    const res: any = await svc.listPartnerMarkets('7');
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual([
      {
        ref_id: '2',
        external_seller_id: 'shop-2',
        elchi_market_id: '777',
        market_name: null,
        phone_number: null,
        tariff_home: null,
        tariff_center: null,
        created_at: new Date('2026-10-03T00:00:00Z'),
      },
      {
        ref_id: '1',
        external_seller_id: 'shop-1',
        elchi_market_id: '500',
        market_name: 'Zamon Store',
        phone_number: '+998901234567',
        tariff_home: 30000,
        tariff_center: 20000,
        created_at: new Date('2026-10-01T00:00:00Z'),
      },
    ]);
    expect(identitySend).toHaveBeenCalledTimes(1);
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.market.find_by_ids' },
      { ids: ['777', '500'] },
    );
  });

  it('hamkor yo`q / raqam emas → 404', async () => {
    const { svc } = build();
    for (const id of ['404', 'abc']) {
      expect(await rpcError(svc.listPartnerMarkets(id))).toEqual(
        expect.objectContaining({ statusCode: 404 }),
      );
    }
  });
});

describe('T1 K1 — linkPartnerMarket', () => {
  const link = (
    svc: IntegrationServiceService,
    over: Record<string, unknown> = {},
  ) =>
    svc.linkPartnerMarket({
      partner_id: '7',
      external_seller_id: ' shop-9 ',
      elchi_market_id: '500',
      requester: SA,
      ...over,
    });

  it('⭐ yangi → 201, tarif marketdan, audit CREATED; tarifga tegilmaydi', async () => {
    const { svc, repo, identitySend, log } = build();
    const res: any = await link(svc);
    expect(res.statusCode).toBe(201);
    expect(res.data).toEqual({
      ref_id: '101',
      external_seller_id: 'shop-9',
      elchi_market_id: '500',
      tariff_home: 30000,
      tariff_center: 20000,
    });
    expect(repo.rows).toHaveLength(1);
    // Faqat o'qish: market.update / create chaqirilmaydi.
    expect(identitySend.mock.calls.map(([p]) => p.cmd)).toEqual([
      'identity.market.find_by_ids',
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'PartnerMarketRef',
        entity_id: '500',
        action: 'created',
        user_id: '1',
        user_role: 'superadmin',
      }),
    );
  });

  it('⭐ 404: hamkor yo`q, market yo`q, kuryer id (find_by_ids bermaydi)', async () => {
    const { svc, repo } = build();
    expect(await rpcError(link(svc, { partner_id: '404' }))).toEqual(
      expect.objectContaining({ statusCode: 404 }),
    );
    for (const marketId of ['123456', '42' /* kuryer */]) {
      expect(await rpcError(link(svc, { elchi_market_id: marketId }))).toEqual(
        expect.objectContaining({ statusCode: 404 }),
      );
    }
    expect(repo.rows).toHaveLength(0);
  });

  it('identity javob bermadi → 502 (404 deb aldamaydi)', async () => {
    const { svc } = build([], { identityDown: true });
    expect(await rpcError(link(svc))).toEqual(
      expect.objectContaining({ statusCode: 502 }),
    );
  });

  it('⭐ 409 PARTNER_SELLER_TAKEN — shu sotuvchi faol bog`langan', async () => {
    const { svc, repo } = build([
      ref({ external_seller_id: 'shop-9', elchi_market_id: '501' }),
    ]);
    expect(await rpcError(link(svc))).toEqual(
      expect.objectContaining({
        statusCode: 409,
        code: 'PARTNER_SELLER_TAKEN',
      }),
    );
    expect(repo.rows[0].elchi_market_id).toBe('501');
  });

  it('⭐ 409 PARTNER_MARKET_TAKEN — market boshqa hamkorda', async () => {
    const { svc, repo } = build([
      ref({ partner_id: '8', elchi_market_id: '500' }),
    ]);
    expect(await rpcError(link(svc))).toEqual(
      expect.objectContaining({
        statusCode: 409,
        code: 'PARTNER_MARKET_TAKEN',
      }),
    );
    expect(repo.rows).toHaveLength(1);
  });

  it('boshqa hamkorning O`CHIRILGAN bog`lanishi to`sqinlik qilmaydi', async () => {
    const { svc } = build([
      ref({ partner_id: '8', elchi_market_id: '500', isDeleted: true }),
    ]);
    expect(((await link(svc)) as any).statusCode).toBe(201);
  });

  it('⭐ o`chirilgan juftlik → yangi qator emas, TIKLANADI (audit UPDATED)', async () => {
    const { svc, repo, log } = build([
      ref({
        id: '9',
        external_seller_id: 'shop-9',
        elchi_market_id: '501',
        isDeleted: true,
      }),
    ]);
    const res: any = await link(svc);
    expect(res.statusCode).toBe(201);
    expect(res.data.ref_id).toBe('9');
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.rows).toEqual([
      expect.objectContaining({
        id: '9',
        isDeleted: false,
        elchi_market_id: '500',
      }),
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'updated',
        old_value: { is_deleted: true, elchi_market_id: '501' },
      }),
    );
  });

  it('unique poyga (23505) → 409 PARTNER_SELLER_TAKEN', async () => {
    const { svc, repo } = build();
    repo.save.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: '23505' }),
    );
    expect(await rpcError(link(svc))).toEqual(
      expect.objectContaining({
        statusCode: 409,
        code: 'PARTNER_SELLER_TAKEN',
      }),
    );
  });

  it('⭐ bog`lagandan keyin POST /partner/markets → 200 idempotent, yangi market ochilmaydi', async () => {
    const { svc, identitySend } = build();
    await link(svc);
    const res: any = await svc.provisionPartnerMarket({
      partner_id: '7',
      external_seller_id: 'shop-9',
      name: 'Zamon',
      phone: '+998901234567',
    });
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual(
      expect.objectContaining({ elchi_market_id: '500', idempotent: true }),
    );
    expect(identitySend).not.toHaveBeenCalledWith(
      { cmd: 'identity.market.create' },
      expect.anything(),
    );
  });

  it('⭐ bog`lagandan keyin POST /partner/shipments egalik tekshiruvidan o`tadi', async () => {
    const { svc, repo } = build();
    Object.assign(svc, {
      partnerShipmentRefRepo: { findOne: jest.fn().mockResolvedValue(null) },
      rmqRequest: jest.fn().mockResolvedValue(null),
    });
    const shipment = {
      partner_id: '7',
      external_order_id: 'EXT-1',
      elchi_market_id: '500',
      customer: { name: 'Ali', phone: '+998901234567' },
      district_id: '12',
      region_id: '1',
      cod_amount: 100000,
    };
    // Bog'lashdan oldin — 403 (IDOR qo'riqchisi).
    await expect(
      (svc as any).createPartnerShipment({ ...shipment }),
    ).rejects.toMatchObject({ error: { statusCode: 403 } });

    // Bog'lash haqiqiy rmqRequest (prototip) bilan ishlaydi.
    delete (svc as any).rmqRequest;
    await link(svc);
    expect(repo.rows).toHaveLength(1);
    (svc as any).rmqRequest = jest.fn().mockResolvedValue(null);
    // Keyingi qadam (mijoz) soxta — muhimi 403 EMASligi.
    await expect(
      (svc as any).createPartnerShipment({ ...shipment }),
    ).rejects.not.toMatchObject({ error: { statusCode: 403 } });
  });
});

describe('T1 K1 — settlement.payment faqat FAOL bog`lanish bo`yicha', () => {
  it('o`chirilgan bog`lanish → "not a partner market"', async () => {
    const { svc, repo } = build([ref({ isDeleted: true })]);
    const res: any = await svc.enqueueSettlementPayment({
      market_id: '500',
      amount: 1000,
      payment_key: 'p-1',
    });
    expect(res.data).toEqual({ skipped: 'not a partner market' });
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { elchi_market_id: '500', isDeleted: false },
    });
  });
});
