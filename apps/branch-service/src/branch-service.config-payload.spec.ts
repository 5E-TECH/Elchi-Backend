import 'reflect-metadata';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { BranchServiceController } from './branch-service.controller';
import { BranchServiceService } from './branch-service.service';

/**
 * RlMb3F26 — filial sozlamalari (branch config): gateway POST/PATCH'ni
 * `{ requester, dto: { branch_id, config_key, ... } }` qilib yuboradi,
 * GET/DELETE esa tekis `{ branch_id, config_key }`. Controller ikkala shaklni
 * ham o'qishi kerak (avval `data.dto.branch_id` ko'rinmay 400 qaytardi).
 */
describe('RlMb3F26 — branch config RMQ payload shakllari', () => {
  const ADMIN = { id: '1', roles: ['admin'] };

  const context = {
    getPattern: () => 'branch.config',
    getMessage: () => ({ fields: { redelivered: false } }),
    getChannelRef: () => ({ ack: jest.fn(), nack: jest.fn() }),
  };
  const rmqService = { ack: jest.fn(), nackForError: jest.fn() };

  describe('controller → servis argumentlari (mock servis)', () => {
    const branchService = {
      setBranchConfig: jest.fn().mockResolvedValue({ statusCode: 201 }),
      updateBranchConfig: jest.fn().mockResolvedValue({ statusCode: 200 }),
      getBranchConfigByKey: jest.fn().mockResolvedValue({ statusCode: 200 }),
      deleteBranchConfig: jest.fn().mockResolvedValue({ statusCode: 200 }),
      getBranchConfig: jest.fn().mockResolvedValue({ statusCode: 200 }),
    };
    const controller = new BranchServiceController(
      rmqService as never,
      branchService as never,
    );
    beforeEach(() => jest.clearAllMocks());

    it.each([
      [
        'gateway shakli { requester, dto: { branch_id, ... } }',
        {
          requester: ADMIN,
          dto: { branch_id: '1', config_key: 'k', config_value: { a: 1 } },
        },
      ],
      [
        'tekis shakl { branch_id, ... }',
        {
          requester: ADMIN,
          branch_id: '1',
          config_key: 'k',
          config_value: { a: 1 },
        },
      ],
    ])('setConfig: %s — branch_id topiladi', async (_label, payload) => {
      await controller.setConfig(payload, context as never);
      expect(branchService.setBranchConfig).toHaveBeenCalledWith(
        { branch_id: '1', config_key: 'k', config_value: { a: 1 } },
        ADMIN,
      );
    });

    it("createConfig (alias) ham gateway shaklini o'qiydi", async () => {
      await controller.createConfig(
        { requester: ADMIN, dto: { branch_id: '1', config_key: 'k' } },
        context as never,
      );
      expect(branchService.setBranchConfig).toHaveBeenCalledWith(
        expect.objectContaining({ branch_id: '1', config_key: 'k' }),
        ADMIN,
      );
    });

    it('updateConfig: branch_id VA config_key nested dto dan olinadi', async () => {
      await controller.updateConfig(
        {
          requester: ADMIN,
          dto: {
            branch_id: '1',
            config_key: 'working_hours',
            config_value: { start: '10:00' },
          },
        },
        context as never,
      );
      expect(branchService.updateBranchConfig).toHaveBeenCalledWith(
        {
          branch_id: '1',
          config_key: 'working_hours',
          config_value: { start: '10:00' },
        },
        ADMIN,
      );
    });

    it('get/find_one/delete tekis shakli va id/key aliaslari ishlaydi', async () => {
      await controller.getConfigByKey(
        { requester: ADMIN, branch_id: '1', config_key: 'k' },
        context as never,
      );
      expect(branchService.getBranchConfigByKey).toHaveBeenCalledWith(
        { branch_id: '1', config_key: 'k' },
        ADMIN,
      );
      await controller.deleteConfig(
        { requester: ADMIN, id: '1', key: 'k' },
        context as never,
      );
      expect(branchService.deleteBranchConfig).toHaveBeenCalledWith(
        { branch_id: '1', config_key: 'k' },
        ADMIN,
      );
      await controller.getConfig(
        { requester: ADMIN, branch_id: '1' },
        context as never,
      );
      expect(branchService.getBranchConfig).toHaveBeenCalledWith('1', ADMIN);
    });
  });

  describe("to'liq oqim: gateway payloadlari → controller → haqiqiy servis", () => {
    let controller: BranchServiceController;
    let configs: any[];

    beforeEach(() => {
      configs = [];
      const branchRepo = {
        findOne: jest.fn(({ where }: any) =>
          Promise.resolve(
            where?.id === '1'
              ? { id: '1', type: 'HQ', level: 0, isDeleted: false }
              : null,
          ),
        ),
      };
      const matches = (row: any, where: any) =>
        Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
      const branchConfigRepo = {
        findOne: jest.fn(({ where }: any) =>
          Promise.resolve(configs.find((r) => matches(r, where)) ?? null),
        ),
        find: jest.fn(({ where }: any) =>
          Promise.resolve(configs.filter((r) => matches(r, where))),
        ),
        create: jest.fn((row: any) => ({ isDeleted: false, ...row })),
        save: jest.fn((row: any) => {
          if (!configs.includes(row)) configs.push(row);
          return Promise.resolve(row);
        }),
      };
      const client = () => ({ send: jest.fn().mockReturnValue(of({})) });
      const service = new BranchServiceService(
        branchRepo as any,
        {} as any,
        branchConfigRepo as any,
        client() as any,
        client() as any,
        client() as any,
        client() as any,
        client() as any,
        { get: jest.fn((_k: string, fallback?: string) => fallback) } as any,
        {
          log: jest.fn().mockResolvedValue(undefined),
          logChange: jest.fn().mockResolvedValue(undefined),
        } as any,
      );
      controller = new BranchServiceController(rmqService as never, service);
    });

    it("POST → 201 va GET ro'yxatda; PATCH → 200 qiymat o'zgaradi; DELETE → 200", async () => {
      // POST /branches/1/config — gateway aynan shunday yuboradi
      const created: any = await controller.setConfig(
        {
          requester: ADMIN,
          dto: {
            branch_id: '1',
            config_key: 'zz_audit_probe',
            config_value: { a: 1 },
          },
        },
        context as never,
      );
      expect(created.statusCode).toBe(201);

      // GET /branches/1/config
      const list: any = await controller.getConfig(
        { branch_id: '1', requester: ADMIN },
        context as never,
      );
      expect(list.data).toEqual([
        expect.objectContaining({
          config_key: 'zz_audit_probe',
          config_value: { a: 1 },
        }),
      ]);

      // PATCH /branches/1/config/zz_audit_probe
      const updated: any = await controller.updateConfig(
        {
          requester: ADMIN,
          dto: {
            branch_id: '1',
            config_key: 'zz_audit_probe',
            config_value: { a: 2 },
          },
        },
        context as never,
      );
      expect(updated.statusCode).toBe(200);
      expect(updated.data.config_value).toEqual({ a: 2 });

      // DELETE /branches/1/config/zz_audit_probe
      const deleted: any = await controller.deleteConfig(
        { branch_id: '1', config_key: 'zz_audit_probe', requester: ADMIN },
        context as never,
      );
      expect(deleted.statusCode).toBe(200);
      const after: any = await controller.getConfig(
        { branch_id: '1', requester: ADMIN },
        context as never,
      );
      expect(after.data).toEqual([]);
    });

    it("branch_id umuman yo'q bo'lsa hali ham 400", async () => {
      await expect(
        controller.setConfig(
          { requester: ADMIN, dto: { config_key: 'k' } },
          context as never,
        ),
      ).rejects.toBeInstanceOf(RpcException);
    });
  });
});
