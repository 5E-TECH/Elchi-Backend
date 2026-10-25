import { createHash } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { IsNull } from 'typeorm';
import { Order_status } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderCustodyService } from './custody/order-custody.service';
import { MarketCancelledHandoverSession } from './entities/market-cancelled-handover-session.entity';
import { Order, OrderHolderType } from './entities/order.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';

describe('OrderServiceService market cancelled handover', () => {
  // zkRab9M2 (BG6): sessiya kodi — servisdagi xesh formulasi bilan bir xil.
  const QR_HASH = 'a'.repeat(64);
  const PIN = '042917';
  const pinHash = (qrHash: string, pin: string) =>
    createHash('sha256').update(`MCP:${qrHash}:${pin}`).digest('hex');

  function setup(options?: {
    qrExpired?: boolean;
    authorizationExpired?: boolean;
    marketQrRequired?: boolean;
    requesterBranch?: unknown;
    pinFailedAttempts?: number;
    pinBlocked?: boolean;
    noPin?: boolean;
    noSession?: boolean;
    authorizedVia?: 'qr' | 'pin' | null;
  }) {
    const now = Date.now();
    const session = {
      id: '1',
      market_id: '16',
      qr_token_hash: QR_HASH,
      qr_expires_at: new Date(now + (options?.qrExpired ? -1_000 : 120_000)),
      scanned_at: null,
      scanned_by_user_id: null,
      authorization_token_hash: null,
      authorization_expires_at: null,
      consumed_at: null,
      pin_hash: options?.noPin ? null : pinHash(QR_HASH, PIN),
      pin_failed_attempts: options?.pinFailedAttempts ?? 0,
      pin_blocked_at: options?.pinBlocked ? new Date(now - 1_000) : null,
      authorized_via: null,
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
      save: jest.fn((value) => value),
      findOne: jest.fn(({ where }: any) => {
        if (where?.authorization_token_hash) {
          return {
            ...session,
            scanned_at: new Date(now),
            scanned_by_user_id: '9',
            authorization_token_hash: where.authorization_token_hash,
            authorization_expires_at: new Date(
              now + (options?.authorizationExpired ? -1_000 : 300_000),
            ),
            authorized_via: options?.authorizedVia ?? 'qr',
          };
        }
        if (options?.noSession) return null;
        // Kod yo'li — market bo'yicha (boshqa marketda sessiya yo'q).
        if (where?.market_id !== undefined) {
          return String(where.market_id) === String(session.market_id)
            ? session
            : null;
        }
        return session;
      }),
    };
    const orderRepo = {
      find: jest.fn().mockResolvedValue([order]),
      save: jest.fn((value) => value),
    };
    const trackingRepo = {
      create: jest.fn((value) => value),
      save: jest.fn((value) => value),
    };
    const custodyRepo = {
      create: jest.fn((value) => value),
      save: jest.fn((value) => value),
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
    const identityClient = {
      send: jest.fn(() =>
        of({
          data: [
            {
              id: '16',
              name: 'Yandex',
              cancelled_handover_qr_required: options?.marketQrRequired ?? true,
            },
          ],
        }),
      ),
    };

    // fL79tFbs (BG2): topshirish joyi nomi — `branch.find_by_id`.
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }, payload: { id?: string }) =>
        of(
          pattern.cmd === 'branch.find_by_id'
            ? {
                data:
                  payload?.id === '1'
                    ? { id: '1', name: 'Toshkent HQ', type: 'HQ' }
                    : null,
              }
            : { data: options?.requesterBranch ?? null },
        ),
      ),
    };

    const custody = new OrderCustodyService(
      trackingRepo as any,
      custodyRepo as any,
    );
    const service = new OrderLifecycleService(
      dataSource as any,
      orderRepo as any,
      {} as any,
      trackingRepo as any,
      custodyRepo as any,
      {} as any,
      {} as any,
      {} as any,
      identityClient as any,
      {} as any,
      {} as any,
      {} as any,
      branchClient as any, // branchClient (fL79tFbs: branch.find_by_id → joy nomi)
      {} as any,
      outbox as any,
      activityLog as any,
      {
        getHqBranchId: jest.fn().mockResolvedValue('1'),
        // getMarketsByIds now lives in OrderLookupService; return the same
        // market the identityClient mock used to feed (drives the QR-required
        // branch in completeMarketCancelledHandover).
        getMarketsByIds: jest.fn().mockResolvedValue([
          {
            id: '16',
            name: 'Yandex',
            cancelled_handover_qr_required: options?.marketQrRequired ?? true,
          },
        ]),
        getCouriersByIds: jest.fn().mockResolvedValue([]),
        getUserById: jest.fn().mockResolvedValue(null),
        getCashboxByUser: jest.fn().mockResolvedValue(null),
        resolveBranchShare: jest.fn().mockResolvedValue(0),
        ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
        resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
        getIntegrationById: jest.fn().mockResolvedValue(null),
        getDefaultDistrictId: jest.fn().mockResolvedValue(null),
        resolveDistrictId: jest.fn().mockResolvedValue(null),
      } as any, // lookup (OrderLookupService)
      custody as any, // OrderCustodyService
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
      identityClient,
      branchClient,
      activityLog,
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
        status: Order_status.RETURNED_TO_MARKET,
        holder_type: OrderHolderType.MARKET,
      }),
    );
    expect(orderRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: Order_status.CANCELLED }),
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

  it('fL79tFbs (BG2): QR yo`li — usul/joy/vaqt buyurtmada, tracking action + metadata bilan', async () => {
    const { service, orderRepo, trackingRepo } = setup();

    await service.completeMarketCancelledHandover({
      market_id: '16',
      order_ids: ['101'],
      authorization_token: 'MHA-valid-token',
      requester: { id: '9', roles: ['admin'] },
    });

    const saved = orderRepo.save.mock.calls[0][0];
    expect(saved).toEqual(
      expect.objectContaining({
        market_handover_method: 'qr',
        market_handover_branch_id: '1',
        market_handover_by: '9',
        market_handover_at: expect.any(Date),
      }),
    );
    expect(saved.last_handover_at).toBe(saved.market_handover_at);
    expect(trackingRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'returned_to_market',
        metadata: {
          method: 'qr',
          market_id: '16',
          branch_id: '1',
          branch_name: 'Toshkent HQ',
          from_holder_type: OrderHolderType.HQ,
          handover_session_id: '1',
        },
      }),
    );
  });

  it('fL79tFbs (BG2): qo`lda tasdiq — method=manual, sabab metadata va buyurtmada', async () => {
    const { service, orderRepo, trackingRepo } = setup();

    await service.completeMarketCancelledHandover({
      market_id: '16',
      order_ids: ['101'],
      authorization_token: 'MHA-valid-token',
      manual_overrides: [{ order_id: '101', reason: 'QR yirtilgan' }],
      requester: { id: '9', roles: ['admin'] },
    });

    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ market_handover_method: 'manual' }),
    );
    expect(trackingRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cancelled_market_handover_manual',
        metadata: expect.objectContaining({
          method: 'manual',
          manual_override: true,
          manual_reason: 'QR yirtilgan',
          branch_id: '1',
          branch_name: 'Toshkent HQ',
        }),
      }),
    );
  });

  it('fL79tFbs (BG2): filial menejeri — joy o`z filiali; nom topilmasa null, topshirish to`xtamaydi', async () => {
    const { service, order, orderRepo, trackingRepo } = setup({
      requesterBranch: { branch_id: '12', branch: { type: 'REGIONAL' } },
    });
    order.holder_type = OrderHolderType.BRANCH;
    order.holder_branch_id = '12';

    const response: any = await service.completeMarketCancelledHandover({
      market_id: '16',
      order_ids: ['101'],
      authorization_token: 'MHA-valid-token',
      requester: { id: '9', roles: ['manager'] },
    });

    expect(response.data.closed_count).toBe(1);
    expect(orderRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: '12',
        }),
      }),
    );
    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ market_handover_branch_id: '12' }),
    );
    expect(trackingRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          branch_id: '12',
          branch_name: null,
          from_holder_type: OrderHolderType.BRANCH,
        }),
      }),
    );
  });

  it('⭐ market QR MAJBURIY — konfig o`chirilgan bo`lsa ham QR`siz topshirib bo`lmaydi (F1)', async () => {
    // Ilgari `cancelled_handover_qr_required=false` bilan QR'ni butunlay
    // chetlab o'tish mumkin edi. Endi konfig E'TIBORSIZ — QR har doim majburiy.
    const { service, sessionRepo } = setup({ marketQrRequired: false });

    await expectRpc(
      service.completeMarketCancelledHandover({
        market_id: '16',
        order_ids: ['101'],
        // authorization_token ATAYLAB berilmadi — market QR ko'rsatilmagan.
        requester: { id: '9', roles: ['admin'] },
      }),
      400,
    );
    // Token yo'q — sessiya umuman qidirilmaydi, topshirish bo'lmaydi.
    expect(sessionRepo.findOne).not.toHaveBeenCalled();
  });

  it('emits a returned_to_market partner signal after closing cancelled orders', async () => {
    const { service, order } = setup();
    order.external_id = 'BP-777';

    const syncSpy = jest
      .spyOn(service as any, 'queueExternalStatusSync')
      .mockResolvedValue(undefined);

    await service.completeMarketCancelledHandover({
      market_id: '16',
      order_ids: ['101'],
      authorization_token: 'MHA-valid-token',
      requester: { id: '9', roles: ['admin'] },
    });

    // BeePost mol qaytganini bilishi uchun `returned_to_market` signali
    // chiqishi SHART (u buni CANCELLED_SENT + 'return' ga xaritalaydi).
    expect(syncSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: '101' }),
      'canceled',
      Order_status.CANCELLED,
      Order_status.RETURNED_TO_MARKET,
    );
  });

  it('rejects unknown manual override reasons', async () => {
    const { service } = setup();

    await expectRpc(
      service.completeMarketCancelledHandover({
        market_id: '16',
        order_ids: ['101'],
        authorization_token: 'MHA-valid-token',
        manual_overrides: [{ order_id: '101', reason: 'random text' }],
        requester: { id: '9', roles: ['admin'] },
      }),
      400,
    );
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

  // ─── zkRab9M2 (BG6): QR yonidagi 6 xonali kod ────────────────────────────
  describe('zkRab9M2 (BG6) — 6 xonali kod (PIN)', () => {
    const admin = { id: '9', roles: ['admin'] };

    async function expectPinError(
      promise: Promise<unknown>,
      reason: string,
      remaining?: number,
    ) {
      try {
        await promise;
        throw new Error('expected RpcException');
      } catch (error) {
        expect(error).toBeInstanceOf(RpcException);
        const payload = (error as RpcException).getError() as any;
        expect(payload.statusCode).toBe(400);
        expect(payload.data.reason).toBe(reason);
        if (remaining !== undefined) {
          expect(payload.data.details).toEqual({
            remaining_attempts: remaining,
            max_attempts: 5,
          });
        }
      }
    }

    it('QR bilan birga kod chiqadi: 6 raqam, javobda ochiq, bazada faqat tuzlangan xesh', async () => {
      const { service, sessionRepo } = setup();

      const response: any = await service.createMarketCancelledHandoverQr({
        market_id: '16',
        requester: { id: '16', roles: ['market'] },
      });

      const { pin, qr_token, qr_expires_at } = response.data;
      expect(pin).toMatch(/^\d{6}$/);
      expect(response.data.pin_expires_at).toBe(qr_expires_at);
      expect(response.data.pin_max_attempts).toBe(5);

      const created = sessionRepo.create.mock.calls[0][0];
      const qrHash = createHash('sha256').update(qr_token).digest('hex');
      expect(created.qr_token_hash).toBe(qrHash);
      expect(created.pin_hash).toBe(pinHash(qrHash, pin));
      expect(created.pin_hash).not.toContain(pin);
      expect(created).toEqual(
        expect.objectContaining({
          pin_failed_attempts: 0,
          pin_blocked_at: null,
          authorized_via: null,
        }),
      );
      expect(JSON.stringify(created)).not.toContain(`"${pin}"`);
    });

    it('to`g`ri kod — QR skani bilan bir xil 5 daqiqalik ruxsat, authorized_via=pin, method=pin', async () => {
      const { service, sessionRepo, queryRunner } = setup();

      const response: any = await service.verifyMarketCancelledHandoverPin({
        market_id: '16',
        pin: PIN,
        requester: admin,
      });

      expect(response.data).toEqual(
        expect.objectContaining({
          market_id: '16',
          authorized: true,
          authorization_token: expect.stringMatching(/^MHA-/),
          remaining_seconds: 300,
          method: 'pin',
        }),
      );
      // Oxirgi skanerlanmagan sessiya — market bo'yicha, qulf bilan.
      expect(sessionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { market_id: '16', scanned_at: IsNull(), isDeleted: false },
          order: { createdAt: 'DESC', id: 'DESC' },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          scanned_by_user_id: '9',
          authorized_via: 'pin',
          authorization_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('QR skani authorized_via=qr yozadi va javobda method=qr', async () => {
      const { service, sessionRepo } = setup();

      const response: any = await service.scanMarketCancelledHandoverQr({
        qr_token: 'MCR-valid-token',
        requester: admin,
      });

      expect(response.data.method).toBe('qr');
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ authorized_via: 'qr' }),
      );
    });

    it('noto`g`ri kod — urinish sanaladi va COMMIT qilinadi (rollback emas), qolgan urinishlar qaytadi', async () => {
      const { service, session, sessionRepo, queryRunner } = setup();

      await expectPinError(
        service.verifyMarketCancelledHandoverPin({
          market_id: '16',
          pin: '111111',
          requester: admin,
        }),
        'market_cancelled_pin_invalid',
        4,
      );

      expect(session.pin_failed_attempts).toBe(1);
      expect(session.pin_blocked_at).toBeNull();
      expect(session.authorization_token_hash).toBeNull();
      expect(sessionRepo.save).toHaveBeenCalledTimes(1);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it('5-xato kod sessiyani bloklaydi (pin_blocked_at), javob — blocked, 0 urinish', async () => {
      const { service, session, queryRunner } = setup({ pinFailedAttempts: 4 });

      await expectPinError(
        service.verifyMarketCancelledHandoverPin({
          market_id: '16',
          pin: '999999',
          requester: admin,
        }),
        'market_cancelled_pin_blocked',
        0,
      );

      expect(session.pin_failed_attempts).toBe(5);
      expect(session.pin_blocked_at).toBeInstanceOf(Date);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('bloklangan sessiya to`g`ri kodni ham, QR skanini ham rad etadi', async () => {
      const pinCase = setup({ pinBlocked: true, pinFailedAttempts: 5 });
      await expectPinError(
        pinCase.service.verifyMarketCancelledHandoverPin({
          market_id: '16',
          pin: PIN,
          requester: admin,
        }),
        'market_cancelled_pin_blocked',
        0,
      );
      expect(pinCase.sessionRepo.save).not.toHaveBeenCalled();
      expect(pinCase.session.authorization_token_hash).toBeNull();

      const qrCase = setup({ pinBlocked: true, pinFailedAttempts: 5 });
      await expectPinError(
        qrCase.service.scanMarketCancelledHandoverQr({
          qr_token: 'MCR-valid-token',
          requester: admin,
        }),
        'market_cancelled_pin_blocked',
      );
      expect(qrCase.sessionRepo.save).not.toHaveBeenCalled();
      expect(qrCase.queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('muddati o`tgan kod — expired, urinish sanalmaydi', async () => {
      const { service, session, sessionRepo } = setup({ qrExpired: true });

      await expectPinError(
        service.verifyMarketCancelledHandoverPin({
          market_id: '16',
          pin: PIN,
          requester: admin,
        }),
        'market_cancelled_pin_expired',
      );
      expect(session.pin_failed_attempts).toBe(0);
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });

    it('boshqa market — faol sessiya topilmaydi (not_found), kod tekshirilmaydi', async () => {
      const { service, session, sessionRepo } = setup();

      await expectPinError(
        service.verifyMarketCancelledHandoverPin({
          market_id: '17',
          pin: PIN,
          requester: admin,
        }),
        'market_cancelled_pin_not_found',
      );
      expect(sessionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ market_id: '17' }),
        }),
      );
      expect(session.pin_failed_attempts).toBe(0);
    });

    it('kodsiz eski sessiya yoki QR yo`q — not_found', async () => {
      for (const options of [{ noPin: true }, { noSession: true }]) {
        const { service } = setup(options);
        await expectPinError(
          service.verifyMarketCancelledHandoverPin({
            market_id: '16',
            pin: PIN,
            requester: admin,
          }),
          'market_cancelled_pin_not_found',
        );
      }
    });

    it('kod formati: 6 raqamdan boshqasi — 400, sessiya qidirilmaydi', async () => {
      for (const pin of ['12345', '1234567', '12a456', '']) {
        const { service, sessionRepo } = setup();
        await expectRpc(
          service.verifyMarketCancelledHandoverPin({
            market_id: '16',
            pin,
            requester: admin,
          }),
          400,
        );
        expect(sessionRepo.findOne).not.toHaveBeenCalled();
      }
    });

    it('rol doirasi: market/kuryer kod yoza olmaydi (403); filial menejeri — mumkin', async () => {
      for (const roles of [['market'], ['courier']]) {
        const { service, sessionRepo } = setup();
        await expectRpc(
          service.verifyMarketCancelledHandoverPin({
            market_id: '16',
            pin: PIN,
            requester: { id: '16', roles },
          }),
          403,
        );
        expect(sessionRepo.findOne).not.toHaveBeenCalled();
      }

      const manager = setup({
        requesterBranch: { branch_id: '12', branch: { type: 'REGIONAL' } },
      });
      const response: any =
        await manager.service.verifyMarketCancelledHandoverPin({
          market_id: '16',
          pin: PIN,
          requester: { id: '9', roles: ['manager'] },
        });
      expect(response.data.method).toBe('pin');
    });

    it('kod bilan ochilgan ruxsat — topshirishda method=pin (buyurtma va tracking metadata)', async () => {
      const { service, orderRepo, trackingRepo, activityLog } = setup({
        authorizedVia: 'pin',
      });

      await service.completeMarketCancelledHandover({
        market_id: '16',
        order_ids: ['101'],
        authorization_token: 'MHA-valid-token',
        requester: admin,
      });

      expect(orderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ market_handover_method: 'pin' }),
      );
      expect(trackingRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'returned_to_market',
          metadata: expect.objectContaining({
            method: 'pin',
            handover_session_id: '1',
          }),
        }),
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ authorized_via: 'pin' }),
        }),
      );
    });

    it('kod sessiyasida ham qo`lda tasdiqlangan posilka — method=manual', async () => {
      const { service, orderRepo } = setup({ authorizedVia: 'pin' });

      await service.completeMarketCancelledHandover({
        market_id: '16',
        order_ids: ['101'],
        authorization_token: 'MHA-valid-token',
        manual_overrides: [{ order_id: '101', reason: 'QR yirtilgan' }],
        requester: admin,
      });

      expect(orderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ market_handover_method: 'manual' }),
      );
    });
  });
});
