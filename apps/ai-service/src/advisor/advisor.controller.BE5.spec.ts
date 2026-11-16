import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import type { RmqService } from '@app/common';
import { AdvisorController } from './advisor.controller';
import type { AdvisorAlertsService } from './advisor-alerts.service';
import type { AdvisorSettingsService } from './advisor-settings.service';

/** BE-5 — ai-service ikkinchi qavat: faqat superadmin; xato konverti. */
describe('AdvisorController (BE-5)', () => {
  const rmq = {
    ack: jest.fn(),
    nackForError: jest.fn(),
  } as unknown as RmqService;
  const ctx = {
    getPattern: () => 'ai.advisor.settings.get',
  } as unknown as RmqContext;
  const settings = {
    get: jest.fn().mockResolvedValue({ version: 1 }),
    update: jest.fn().mockResolvedValue({ version: 2 }),
  };
  const alerts = {
    overview: jest.fn().mockResolvedValue({ alerts: {} }),
    list: jest.fn().mockResolvedValue({ items: [] }),
    get: jest.fn().mockResolvedValue({ id: '1' }),
    update: jest.fn().mockResolvedValue({ id: '1', status: 'resolved' }),
  };
  const controller = new AdvisorController(
    rmq,
    settings as unknown as AdvisorSettingsService,
    alerts as unknown as AdvisorAlertsService,
  );

  const errorOf = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcException);
    return (err as RpcException).getError() as Record<string, unknown>;
  };

  beforeEach(() => jest.clearAllMocks());

  it('superadmin: GET → successRes konverti', async () => {
    await expect(
      controller.getSettings(
        { requester: { id: '1', roles: ['superadmin'] } },
        ctx,
      ),
    ).resolves.toEqual({
      statusCode: 200,
      message: 'AI advisor settings',
      data: { version: 1 },
    });
  });

  it.each([
    [{ id: '2', roles: ['admin'] }],
    [{ id: '2', roles: ['manager', 'cashier'] }],
    [{ id: '', roles: ['superadmin'] }],
    [{ id: '1x', roles: ['superadmin'] }],
    [undefined],
  ])(
    'superadmin emas / yaroqsiz requester %j → 403, servis chaqirilmaydi',
    async (requester) => {
      expect(
        await errorOf(controller.getSettings({ requester }, ctx)),
      ).toMatchObject({
        statusCode: 403,
      });
      expect(
        await errorOf(
          controller.updateSettings({ requester, patch: { version: 1 } }, ctx),
        ),
      ).toMatchObject({ statusCode: 403 });
      expect(settings.get).not.toHaveBeenCalled();
      expect(settings.update).not.toHaveBeenCalled();
    },
  );

  it('PATCH: requester (ism bilan) va patch servisga', async () => {
    await controller.updateSettings(
      {
        requester: { id: '1', roles: ['superadmin'], name: 'SA' },
        patch: { version: 1 },
      },
      ctx,
    );
    expect(settings.update).toHaveBeenCalledWith(
      { id: '1', roles: ['superadmin'], name: 'SA' },
      { version: 1 },
    );
  });

  it('kutilmagan xato → 500 (ichki matn chiqmaydi)', async () => {
    settings.get.mockRejectedValueOnce(
      new Error('connection refused 10.0.0.5'),
    );
    const body = await errorOf(
      controller.getSettings(
        { requester: { id: '1', roles: ['superadmin'] } },
        ctx,
      ),
    );
    expect(body).toMatchObject({
      statusCode: 500,
      message: 'ai.advisor.settings.get bajarilmadi',
    });
  });

  it('alerts: superadmin emas — 403, servis chaqirilmaydi; get sukut mark_seen=true', async () => {
    const admin = { id: '2', roles: ['admin'] };
    for (const call of [
      () => controller.overview({ requester: admin }, ctx),
      () => controller.listAlerts({ requester: admin }, ctx),
      () => controller.getAlert({ requester: admin, id: '1' }, ctx),
      () =>
        controller.updateAlert(
          { requester: admin, id: '1', status: 'resolved', note: 'abc' },
          ctx,
        ),
    ]) {
      expect(await errorOf(call())).toMatchObject({ statusCode: 403 });
    }
    expect(alerts.overview).not.toHaveBeenCalled();
    expect(alerts.get).not.toHaveBeenCalled();
    expect(alerts.update).not.toHaveBeenCalled();

    const sa = { id: '1', roles: ['superadmin'], name: 'SA' };
    await expect(
      controller.getAlert(
        { requester: sa, id: '7', include: ['history'] },
        ctx,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      message: 'AI advisor alert',
    });
    expect(alerts.get).toHaveBeenCalledWith(sa, '7', {
      mark_seen: true,
      include: ['history'],
    });
    await controller.getAlert(
      { requester: sa, id: '7', mark_seen: false },
      ctx,
    );
    expect(alerts.get).toHaveBeenLastCalledWith(sa, '7', {
      mark_seen: false,
      include: [],
    });
    await controller.updateAlert(
      { requester: sa, id: '7', status: 'dismissed', note: null },
      ctx,
    );
    expect(alerts.update).toHaveBeenCalledWith(sa, '7', 'dismissed', null);
  });
});
