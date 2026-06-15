import { RpcException } from '@nestjs/microservices';
import { Order_status } from '@app/common';
import { OrderServiceService } from './order-service.service';
import { MarketCancelledHandoverSession } from './entities/market-cancelled-handover-session.entity';
import { Order, OrderHolderType } from './entities/order.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';

describe('OrderServiceService market cancelled handover', () => {
  function setup(options?: {
    qrExpired?: boolean;
    authorizationExpired?: boolean;
  }) {
    const now = Date.now();
    const session = {
      id: '1',
      market_id: '16',
      qr_token_hash: '',
      qr_expires_at: new Date(now + (options?.qrExpired ? -1_000 : 120_000)),
      scanned_at: null,
      scanned_by_user_id: null,
      authorization_token_hash: null,
      authorization_expires_at: null,
      consumed_at: null,
      isDeleted: false,
    } as any;
    const order = {
      id: '101',
      market_id: '16',
      status: Order_status.CANCELLED,
      holder_type: OrderHolderType.HQ,
      holder_branch_id: null,
      holder_courier_id: null,
      canceled_post_id: null,
      return_requested: false,
      isDeleted: false,
    } as any;

    const sessionRepo = {
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      })),
      create: jest.fn((value) => ({ id: '1', ...value })),
      save: jest.fn(async (value) => value),
      findOne: jest.fn(async ({ where }: any) => {
        if (where?.authorization_token_hash) {
          return {
            ...session,
            scanned_at: new Date(now),
            scanned_by_user_id: '9',
            authorization_token_hash: where.authorization_token_hash,
            authorization_expires_at: new Date(
              now + (options?.authorizationExpired ? -1_000 : 300_000),
            ),
          };
        }
        return session;
      }),
    };
    const orderRepo = {
      find: jest.fn().mockResolvedValue([order]),
      save: jest.fn(async (value) => value),
    };
    const trackingRepo = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    const custodyRepo = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) => {
          if (entity.name === MarketCancelledHandoverSession.name) {
            return sessionRepo;
          }
          if (entity.name === Order.name) return orderRepo;
          if (entity.name === OrderTracking.name) return trackingRepo;
          if (entity.name === OrderCustodyEvent.name) return custodyRepo;
          return {};
        }),
      },
    };
    const dataSource = {
      getRepository: jest.fn((entity: { name: string }) => {
        if (entity.name === MarketCancelledHandoverSession.name) {
          return sessionRepo;
        }
        return {};
      }),
      createQueryRunner: jest.fn(() => queryRunner),
    };
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };

    const service = new OrderServiceService(
      dataSource as any,
      orderRepo as any,
      {} as any,
      trackingRepo as any,
      custodyRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      outbox as any,
      activityLog as any,
    );

    return {
      service,
      session,
      sessionRepo,
      order,
      orderRepo,
      trackingRepo,
      custodyRepo,
      queryRunner,
    };
  }

  async function expectRpc(promise: Promise<unknown>, statusCode: number) {
    try {
      await promise;
      throw new Error('expected RpcException');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      expect(((error as RpcException).getError() as any)?.statusCode).toBe(
        statusCode,
      );
    }
  }

  it('creates a two-minute QR without storing the raw token', async () => {
    const { service, sessionRepo } = setup();

    const response: any = await service.createMarketCancelledHandoverQr({
      market_id: '16',
      requester: { id: '16', roles: ['market'] },
    });

    expect(response.data.qr_token).toMatch(/^MCR-/);
    expect(response.data.qr_ttl_seconds).toBe(120);
    expect(sessionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: '16',
        qr_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(sessionRepo.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ qr_token_hash: response.data.qr_token }),
    );
  });

  it('opens a five-minute authorization when HQ admin scans the QR', async () => {
    const { service, sessionRepo, queryRunner } = setup();

    const response: any = await service.scanMarketCancelledHandoverQr({
      qr_token: 'MCR-valid-token',
      requester: { id: '9', roles: ['admin'] },
    });

    expect(response.data.authorization_token).toMatch(/^MHA-/);
    expect(response.data.remaining_seconds).toBe(300);
    expect(sessionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        scanned_by_user_id: '9',
        authorization_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('rejects a QR after its two-minute lifetime', async () => {
    const { service, queryRunner } = setup({ qrExpired: true });

    await expectRpc(
      service.scanMarketCancelledHandoverQr({
        qr_token: 'MCR-expired-token',
        requester: { id: '9', roles: ['admin'] },
      }),
      400,
    );

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('closes HQ-held cancelled orders and moves custody to MARKET', async () => {
    const {
      service,
      sessionRepo,
      orderRepo,
      trackingRepo,
      custodyRepo,
      queryRunner,
    } = setup();

    const response: any = await service.completeMarketCancelledHandover({
      market_id: '16',
      order_ids: ['101'],
      authorization_token: 'MHA-valid-token',
      requester: { id: '9', roles: ['admin'] },
    });

    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: Order_status.CLOSED,
        holder_type: OrderHolderType.MARKET,
      }),
    );
    expect(trackingRepo.save).toHaveBeenCalled();
    expect(custodyRepo.save).toHaveBeenCalled();
    expect(sessionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ consumed_at: expect.any(Date) }),
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(response.data.closed_count).toBe(1);
  });

  it('rejects an expired five-minute authorization', async () => {
    const { service, queryRunner } = setup({
      authorizationExpired: true,
    });

    await expectRpc(
      service.completeMarketCancelledHandover({
        market_id: '16',
        order_ids: ['101'],
        authorization_token: 'MHA-expired-token',
        requester: { id: '9', roles: ['admin'] },
      }),
      403,
    );

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });
});
