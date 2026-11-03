import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ORDER_NOT_IN_YOUR_BRANCH,
  ORDER_NOT_IN_YOUR_BRANCH_MESSAGE,
  QR_BRANCH_SCOPE_UNAVAILABLE,
  QR_REQUESTER_BRANCH_NOT_ASSIGNED,
  QR_REQUESTER_BRANCH_NOT_ASSIGNED_MESSAGE,
  createQrOrderBranchScope,
  isQrBranchScopedRequester,
  isQrOrderHeldByCourier,
  qrOrderBranchScopeRpcDeps,
  qrOrderResponsibleBranchId,
  type QrOrderBranchScopeDeps,
} from './order-qr-branch-scope';

/**
 * anKpzwxk (ega qarori 7) — begona QR: filial doirasi yordamchisi.
 */
const HQ = '1';

function deps(
  overrides: Partial<{
    branchId: string | Error;
    hqId: string | Error;
    batch: Record<string, unknown> | null | Error;
  }> = {},
) {
  const value = <T>(v: T | Error): Promise<T> =>
    v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  const d = {
    resolveRequesterBranchId: jest.fn(() => value(overrides.branchId ?? '5')),
    resolveHqBranchId: jest.fn(() => value(overrides.hqId ?? HQ)),
    findTransferBatch: jest.fn(() =>
      value(overrides.batch === undefined ? null : overrides.batch),
    ),
  };
  return d as typeof d & QrOrderBranchScopeDeps;
}

const manager = { sub: '50', roles: ['manager'] };
const courier = { sub: '70', roles: ['courier'] };

describe('anKpzwxk — begona QR doirasi (yordamchi)', () => {
  describe('isQrBranchScopedRequester', () => {
    it.each([
      [['manager'], true],
      [['registrator'], true],
      [['branch'], true],
      [['courier'], true],
      [['superadmin'], false],
      [['admin'], false],
      [['market'], false],
      [['logist'], false],
      [['admin', 'manager'], false],
      [['market', 'courier'], false],
      [[], false],
    ])('%j -> %s', (roles, expected) => {
      expect(isQrBranchScopedRequester(roles)).toBe(expected);
    });
  });

  it('mas`ul filial — holder_branch_id, bo`lmasa branch_id', () => {
    expect(
      qrOrderResponsibleBranchId({ holder_branch_id: '7', branch_id: '5' }),
    ).toBe('7');
    expect(
      qrOrderResponsibleBranchId({ holder_branch_id: null, branch_id: '5' }),
    ).toBe('5');
    expect(qrOrderResponsibleBranchId({ branchId: 5 })).toBe('5');
    expect(qrOrderResponsibleBranchId({})).toBe('');
  });

  it('kuryerdagi buyurtma — courier_id yoki holder_courier_id', () => {
    expect(isQrOrderHeldByCourier({ courier_id: '70' }, '70')).toBe(true);
    expect(isQrOrderHeldByCourier({ holder_courier_id: 70 }, '70')).toBe(true);
    expect(isQrOrderHeldByCourier({ courier_id: '71' }, '70')).toBe(false);
    expect(isQrOrderHeldByCourier({ courier_id: '' }, '')).toBe(false);
  });

  it('o`z filiali buyurtmasi -> ko`rinadi (HQ va paket so`ralmaydi)', async () => {
    const d = deps();
    await expect(
      createQrOrderBranchScope(manager, d).assertVisible({
        id: '9',
        holder_branch_id: '5',
      }),
    ).resolves.toBeUndefined();
    expect(d.resolveHqBranchId).not.toHaveBeenCalled();
    expect(d.findTransferBatch).not.toHaveBeenCalled();
  });

  it('begona filial buyurtmasi -> 403 order_not_in_your_branch', async () => {
    const error: unknown = await createQrOrderBranchScope(manager, deps())
      .assertVisible({ id: '9', holder_branch_id: '6', branch_id: '6' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      statusCode: 403,
      message: ORDER_NOT_IN_YOUR_BRANCH_MESSAGE,
      data: { reason: ORDER_NOT_IN_YOUR_BRANCH },
    });
  });

  it('holder_branch_id ustun: branch_id mos, lekin ushlovchi boshqa filial -> 403', async () => {
    await expect(
      createQrOrderBranchScope(manager, deps()).assertVisible({
        holder_branch_id: '6',
        branch_id: '5',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('kuryer: o`zidagi buyurtma — filial so`ralmaydi', async () => {
    const d = deps({ branchId: new Error('down') });
    await expect(
      createQrOrderBranchScope(courier, d).assertVisible({
        holder_branch_id: '6',
        holder_courier_id: '70',
      }),
    ).resolves.toBeUndefined();
    expect(d.resolveRequesterBranchId).not.toHaveBeenCalled();
  });

  it('kuryer: o`z filialidagi (hali o`zida emas) -> ko`rinadi, begona -> 403', async () => {
    await expect(
      createQrOrderBranchScope(courier, deps()).assertVisible({
        branch_id: '5',
      }),
    ).resolves.toBeUndefined();
    await expect(
      createQrOrderBranchScope(courier, deps()).assertVisible({
        branch_id: '6',
        courier_id: '71',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('HQ xodimi / HQ kuryeri -> cheklanmaydi', async () => {
    for (const user of [manager, courier]) {
      const scope = createQrOrderBranchScope(user, deps({ branchId: HQ }));
      await expect(scope.isUnrestricted()).resolves.toBe(true);
      await expect(
        scope.assertVisible({ holder_branch_id: '6' }),
      ).resolves.toBeUndefined();
    }
  });

  it('SA/admin/market — doira qo`llanmaydi, hech narsa so`ralmaydi', async () => {
    for (const roles of [['superadmin'], ['admin'], ['market']]) {
      const d = deps();
      const scope = createQrOrderBranchScope({ sub: '1', roles }, d);
      await expect(scope.isUnrestricted()).resolves.toBe(true);
      await expect(
        scope.assertVisible({ holder_branch_id: '6' }),
      ).resolves.toBeUndefined();
      expect(d.resolveRequesterBranchId).not.toHaveBeenCalled();
    }
  });

  it('SENT paket manzili — so`rovchi filiali -> ko`rinadi', async () => {
    const d = deps({
      batch: { id: '30', status: 'SENT', destination_branch_id: '5' },
    });
    await expect(
      createQrOrderBranchScope(manager, d).assertVisible({
        holder_branch_id: '6',
        current_batch_id: '30',
      }),
    ).resolves.toBeUndefined();
    expect(d.findTransferBatch).toHaveBeenCalledWith('30');
  });

  it.each([
    ['PENDING paket', { status: 'PENDING', destination_branch_id: '5' }],
    ['boshqa manzil', { status: 'SENT', destination_branch_id: '8' }],
    ['paket topilmadi', null],
  ])('%s -> 403', async (_label, batch) => {
    await expect(
      createQrOrderBranchScope(manager, deps({ batch })).assertVisible({
        holder_branch_id: '6',
        current_batch_id: '30',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('filialga biriktirilmagan xodim -> 403 branch_not_assigned (paket so`ralmaydi)', async () => {
    const d = deps({ branchId: '' });
    const error: unknown = await createQrOrderBranchScope(manager, d)
      .assertVisible({ branch_id: '6', current_batch_id: '30' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      statusCode: 403,
      message: QR_REQUESTER_BRANCH_NOT_ASSIGNED_MESSAGE,
      data: { reason: QR_REQUESTER_BRANCH_NOT_ASSIGNED },
    });
    expect(d.resolveHqBranchId).not.toHaveBeenCalled();
    expect(d.findTransferBatch).not.toHaveBeenCalled();
  });

  it('filialga biriktirilmagan kuryer: o`zidagi -> ko`rinadi, boshqasi -> 403 branch_not_assigned', async () => {
    await expect(
      createQrOrderBranchScope(courier, deps({ branchId: '' })).assertVisible({
        branch_id: '6',
        courier_id: '70',
      }),
    ).resolves.toBeUndefined();
    await expect(
      createQrOrderBranchScope(courier, deps({ branchId: '' })).assertVisible({
        branch_id: '6',
      }),
    ).rejects.toMatchObject({
      response: { data: { reason: QR_REQUESTER_BRANCH_NOT_ASSIGNED } },
    });
  });

  // 7-qaror matni: «filialga kelayotgan» kuryerga ham — HQ->filial pochtasi
  // jo'natilgach (holder_branch_id = manzil) buyurtma ko'rinadi. Ega boshqacha
  // qaror qilsa — shu spec ataylab o'zgartiriladi.
  it('kuryer: o`z filialiga jo`natilgan (hali qabul qilinmagan) pochta buyurtmasi -> ko`rinadi', async () => {
    await expect(
      createQrOrderBranchScope(courier, deps()).assertVisible({
        status: 'on the road',
        post_id: '12',
        branch_id: '5',
        holder_branch_id: '5',
        holder_type: 'BRANCH',
        holder_courier_id: null,
      }),
    ).resolves.toBeUndefined();
  });

  describe('fail-closed — 503 branch_scope_unavailable', () => {
    const expect503 = async (promise: Promise<unknown>) => {
      const error: unknown = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (error as ServiceUnavailableException).getResponse(),
      ).toMatchObject({ data: { reason: QR_BRANCH_SCOPE_UNAVAILABLE } });
    };

    it('filial aniqlanmadi', async () => {
      await expect503(
        createQrOrderBranchScope(
          courier,
          deps({ branchId: new Error('timeout') }),
        ).assertVisible({ branch_id: '5' }),
      );
    });

    it('HQ aniqlanmadi va buyurtma o`z filialida emas', async () => {
      await expect503(
        createQrOrderBranchScope(
          manager,
          deps({ hqId: new Error('down') }),
        ).assertVisible({ branch_id: '6' }),
      );
    });

    it('HQ aniqlanmasa ham o`z filialidagi buyurtma ko`rinadi', async () => {
      await expect(
        createQrOrderBranchScope(
          manager,
          deps({ hqId: new Error('down') }),
        ).assertVisible({ branch_id: '5' }),
      ).resolves.toBeUndefined();
    });

    it('paket so`rovi yiqildi', async () => {
      await expect503(
        createQrOrderBranchScope(
          manager,
          deps({ batch: new Error('down') }),
        ).assertVisible({ branch_id: '6', current_batch_id: '30' }),
      );
    });

    it('isUnrestricted xatoda false (to`g`ri yo`lga o`tadi), so`rovlar bir marta', async () => {
      const d = deps({ hqId: new Error('down') });
      const scope = createQrOrderBranchScope(manager, d);
      await expect(scope.isUnrestricted()).resolves.toBe(false);
      await expect503(scope.assertVisible({ branch_id: '6' }));
      expect(d.resolveRequesterBranchId).toHaveBeenCalledTimes(1);
      expect(d.resolveHqBranchId).toHaveBeenCalledTimes(1);
    });
  });
});

describe('anKpzwxk — qrOrderBranchScopeRpcDeps (QR ikkala yo`li uchun manba)', () => {
  const rpc = (
    branch: Record<string, unknown> = {},
    order: Record<string, unknown> = {},
  ) => {
    const reply = (handlers: Record<string, unknown>) =>
      jest.fn((pattern: { cmd: string }) => {
        const value = handlers[pattern.cmd];
        return value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(value ?? { statusCode: 200, data: null });
      });
    return { sendBranch: reply(branch), sendOrder: reply(order) };
  };

  it('filial xodimi + JWT branch_id -> JWT (RMQ yo`q)', async () => {
    const r = rpc();
    await expect(
      qrOrderBranchScopeRpcDeps(
        { sub: '50', roles: ['manager'], branch_id: '5' },
        r,
      ).resolveRequesterBranchId(),
    ).resolves.toBe('5');
    expect(r.sendBranch).not.toHaveBeenCalled();
  });

  it.each([
    ['kuryer (JWT branch_id e`tiborga olinmaydi)', ['courier'], '9'],
    ['JWT branch_id siz registrator', ['registrator'], undefined],
  ])('%s -> branch.user.find_by_user', async (_l, roles, jwtBranch) => {
    const r = rpc({
      'branch.user.find_by_user': { statusCode: 200, data: { branch_id: 5 } },
    });
    await expect(
      qrOrderBranchScopeRpcDeps(
        { sub: '70', roles, branch_id: jwtBranch },
        r,
      ).resolveRequesterBranchId(),
    ).resolves.toBe('5');
    expect(r.sendBranch).toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_user' },
      { user_id: '70', requester: { id: '70', roles } },
    );
  });

  it('branch_users qatori yo`q -> `` (biriktirilmagan), xato -> uzatiladi', async () => {
    await expect(
      qrOrderBranchScopeRpcDeps(
        { sub: '70', roles: ['courier'] },
        rpc(),
      ).resolveRequesterBranchId(),
    ).resolves.toBe('');
    await expect(
      qrOrderBranchScopeRpcDeps(
        { sub: '70', roles: ['courier'] },
        rpc({ 'branch.user.find_by_user': new Error('down') }),
      ).resolveRequesterBranchId(),
    ).rejects.toThrow('down');
  });

  it('HQ — branch.find_hq', async () => {
    await expect(
      qrOrderBranchScopeRpcDeps(
        manager,
        rpc({ 'branch.find_hq': { statusCode: 200, data: { id: 1 } } }),
      ).resolveHqBranchId(),
    ).resolves.toBe('1');
  });

  it('paket: topildi -> qator, 404 -> null, boshqa xato -> uzatiladi', async () => {
    const batch = { id: '30', status: 'SENT', destination_branch_id: '5' };
    const found = rpc(
      {},
      { 'order.transfer_batch.find_by_id': { statusCode: 200, data: batch } },
    );
    await expect(
      qrOrderBranchScopeRpcDeps(manager, found).findTransferBatch('30'),
    ).resolves.toEqual(batch);
    expect(found.sendOrder).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.find_by_id' },
      { id: '30' },
    );
    await expect(
      qrOrderBranchScopeRpcDeps(
        manager,
        rpc(
          {},
          {
            'order.transfer_batch.find_by_id': Object.assign(new Error('nf'), {
              statusCode: 404,
            }),
          },
        ),
      ).findTransferBatch('30'),
    ).resolves.toBeNull();
    await expect(
      qrOrderBranchScopeRpcDeps(
        manager,
        rpc({}, { 'order.transfer_batch.find_by_id': new Error('down') }),
      ).findTransferBatch('30'),
    ).rejects.toThrow('down');
  });
});
