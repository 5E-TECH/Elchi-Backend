import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';

/**
 * provisionPartnerMarket (C1.5) — prototip orqali sinaladi (og'ir konstruktorsiz).
 */
function makeService(
  refRepo: Record<string, jest.Mock>,
  identitySend: jest.Mock,
  log: jest.Mock,
) {
  const svc = Object.create(IntegrationServiceService.prototype);
  svc.partnerMarketRefRepo = refRepo;
  svc.identityClient = { send: identitySend };
  svc.activityLog = { log };
  return svc as IntegrationServiceService;
}

const baseDto = {
  partner_id: '7',
  external_seller_id: 'shop-9',
  name: 'Zamon Store',
  phone: '+998901234567',
};

describe('IntegrationServiceService.provisionPartnerMarket (C1.5)', () => {
  it('TC1/TC3: yangi -> market.create chaqiriladi, ref (partner_id bilan) saqlanadi, id qaytadi', async () => {
    const saved: any[] = [];
    const refRepo = {
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: any) => {
        saved.push(x);
        return Promise.resolve({ id: '1', ...x });
      }),
    };
    const identity = jest.fn(() => of({ data: { id: 500 } }));
    const log = jest.fn(() => Promise.resolve(undefined));
    const svc = makeService(refRepo, identity, log);

    const res: any = await svc.provisionPartnerMarket({ ...baseDto });

    expect(res.statusCode).toBe(201);
    expect(res.data.elchi_market_id).toBe('500');
    // identity.market.create bir marta, sensible dto bilan
    expect(identity).toHaveBeenCalledWith(
      { cmd: 'identity.market.create' },
      expect.objectContaining({
        dto: expect.objectContaining({
          name: 'Zamon Store',
          phone_number: '+998901234567',
          username: expect.any(String),
          default_tariff: 'center',
        }),
        requester: expect.objectContaining({ id: 'partner:7' }),
      }),
    );
    // TC3: ref partner_id bilan bog'langan
    expect(saved[0]).toEqual({
      partner_id: '7',
      external_seller_id: 'shop-9',
      elchi_market_id: '500',
    });
    expect(log).toHaveBeenCalled();
  });

  it('TC2: idempotent — mavjud ref bo‘lsa yangi market ochilmaydi', async () => {
    const refRepo = {
      findOne: jest.fn(() => Promise.resolve({ elchi_market_id: '500' })),
      create: jest.fn(),
      save: jest.fn(),
    };
    const identity = jest.fn();
    const svc = makeService(refRepo, identity, jest.fn());

    const res: any = await svc.provisionPartnerMarket({ ...baseDto });

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ elchi_market_id: '500', idempotent: true });
    expect(identity).not.toHaveBeenCalled(); // market.create YO'Q
    expect(refRepo.save).not.toHaveBeenCalled();
  });

  it('external_seller_id yo‘q -> 400 (RpcException)', async () => {
    const svc = makeService(
      { findOne: jest.fn() } as any,
      jest.fn(),
      jest.fn(),
    );
    await expect(
      svc.provisionPartnerMarket({ partner_id: '7', name: 'x', phone: 'y' }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('market yaratilmasa (id yo‘q) -> 502', async () => {
    const refRepo = {
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(),
      save: jest.fn(),
    };
    const identity = jest.fn(() => of({ data: {} })); // id yo'q
    const svc = makeService(refRepo, identity, jest.fn());

    await expect(
      svc.provisionPartnerMarket({ ...baseDto }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(refRepo.save).not.toHaveBeenCalled();
  });
});
