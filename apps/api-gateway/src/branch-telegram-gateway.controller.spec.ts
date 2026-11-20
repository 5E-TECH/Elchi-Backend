import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { of } from 'rxjs';
import { BranchTelegramGatewayController } from './branch-telegram-gateway.controller';

/**
 * Filial kassasi Telegram guruhi — gateway huquq qoidalari: superadmin /
 * admin — istalgan filial; menejer — faqat `branch_users` dagi o'z filiali;
 * HQ filiali (asosiy kassa) — o'zgartirish faqat superadmin.
 */

const BRANCHES: Record<string, { id: string; name: string; type: string }> = {
  '12': { id: '12', name: 'Chilonzor', type: 'BRANCH' },
  '1': { id: '1', name: 'HQ Toshkent', type: 'HQ' },
};

const setup = (managerBranchId = '12') => {
  const notification = {
    send: jest.fn(
      (pattern: { cmd: string }, payload: Record<string, unknown>) =>
        of({
          statusCode: 200,
          data:
            pattern.cmd === 'notification.telegram.branch_status'
              ? {
                  branch_id: payload.branch_id,
                  report_target: 'group',
                  group: null,
                }
              : { ok: true },
        }),
    ),
  };
  const branch = {
    send: jest.fn(
      (pattern: { cmd: string }, payload: Record<string, unknown>) => {
        if (pattern.cmd === 'branch.user.find_by_user') {
          return of({ data: { branch_id: managerBranchId, role: 'MANAGER' } });
        }
        return of({ data: BRANCHES[String(payload.id)] ?? null });
      },
    ),
  };
  const controller = new BranchTelegramGatewayController(
    notification as never,
    branch as never,
  );
  return { controller, notification, branch };
};

const req = (roles: string[], sub = '301') => ({
  user: { sub, roles },
  ip: '10.0.0.1',
});

describe('BranchTelegramGatewayController', () => {
  it("menejer o'z filiali: holat (`can_manage: true`) va ulash kodi — filial nomi bilan", async () => {
    const fx = setup('12');
    const status = await fx.controller.status('12', req(['manager']));
    expect(status.data).toMatchObject({
      branch_id: '12',
      report_target: 'group',
      can_manage: true,
    });
    await fx.controller.linkCode('12', req(['manager']));
    expect(fx.notification.send).toHaveBeenLastCalledWith(
      { cmd: 'notification.telegram.branch_link_code' },
      {
        branch_id: '12',
        branch_name: 'Chilonzor',
        requester: { id: '301', roles: ['manager'] },
        ip: '10.0.0.1',
      },
    );
  });

  it('menejer boshqa filial — 403, notification chaqirilmaydi', async () => {
    const fx = setup('77');
    await expect(
      fx.controller.status('12', req(['manager'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      fx.controller.reportTarget(
        '12',
        { report_target: 'private' },
        req(['manager']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fx.notification.send).not.toHaveBeenCalled();
  });

  it('admin istalgan filial; HQ — admin faqat ko‘radi, superadmin boshqaradi', async () => {
    const fx = setup();
    await fx.controller.unlink('12', req(['admin']));
    expect(fx.notification.send).toHaveBeenLastCalledWith(
      { cmd: 'notification.telegram.branch_unlink' },
      { branch_id: '12', requester: { id: '301', roles: ['admin'] } },
    );
    const hqStatus = await fx.controller.status('1', req(['admin']));
    expect(hqStatus.data).toMatchObject({ can_manage: false });
    await expect(
      fx.controller.linkCode('1', req(['admin'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await fx.controller.reportTarget(
      '1',
      { report_target: 'private' },
      req(['superadmin']),
    );
    expect(fx.notification.send).toHaveBeenLastCalledWith(
      { cmd: 'notification.telegram.branch_report_target' },
      {
        branch_id: '1',
        report_target: 'private',
        requester: { id: '301', roles: ['superadmin'] },
      },
    );
    // Admin branch_users'ga qaramaydi.
    expect(fx.branch.send).not.toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_user' },
      expect.anything(),
    );
  });

  it('yaroqsiz / topilmagan filial — 404', async () => {
    const fx = setup();
    await expect(
      fx.controller.status('0', req(['admin'])),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      fx.controller.status('abc', req(['admin'])),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      fx.controller.status('55', req(['admin'])),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
