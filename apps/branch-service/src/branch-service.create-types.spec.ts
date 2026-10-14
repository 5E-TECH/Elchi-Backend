import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    Status: {
      ...(actual.Status ?? {}),
      ACTIVE: 'active',
      INACTIVE: 'inactive',
    },
    BranchType: {
      HQ: 'HQ',
      PICKUP: 'PICKUP',
      REGIONAL: 'REGIONAL',
      HYBRID: 'HYBRID',
    },
  };
});

/**
 * EiZj47Gc — filial yaratish: barcha 4 tur (HQ/PICKUP/REGIONAL/HYBRID).
 * Qaror (kartadagi tavsiya): PICKUP ham ota filialga ega bo'ladi — HQ'dan
 * boshqa har qanday tur uchun parent_id majburiy. Bo'sh satr (`''`, forma
 * shunday yuboradi) null deb qabul qilinadi va aniq o'zbekcha 400 qaytadi.
 */
describe('EiZj47Gc — createBranch: barcha filial turlari', () => {
  let service: BranchServiceService;
  let branchRepo: any;
  const ADMIN = { id: '1', roles: ['admin'] };
  const HQ_ROW = { id: '1', type: 'HQ', level: 0, isDeleted: false };
  const REGIONAL_ROW = {
    id: '7',
    type: 'REGIONAL',
    level: 1,
    isDeleted: false,
  };

  beforeEach(() => {
    branchRepo = {
      // ensureBranchCodeUnique → { where: { code } } → null (band emas);
      // HQ yagonaligi → { where: { type: HQ } } → null;
      // getParentBranchOrThrow → { where: { id } } → ota filial.
      findOne: jest.fn(({ where }: any) => {
        if (where?.id === '1') return Promise.resolve(HQ_ROW);
        if (where?.id === '7') return Promise.resolve(REGIONAL_ROW);
        return Promise.resolve(null);
      }),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: any) => Promise.resolve({ id: '99', ...row })),
      create: jest.fn((row: unknown) => row),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      })),
      manager: { query: jest.fn().mockResolvedValue([]) },
      metadata: { tablePath: 'branch_schema.branches' },
    };
    const client = () => ({
      send: jest.fn().mockReturnValue(of({ data: {} })),
    });
    service = new BranchServiceService(
      branchRepo,
      {} as any,
      {} as any,
      client() as any,
      client() as any,
      client() as any,
      client() as any,
      client() as any,
      { get: jest.fn((_k: string, fallback?: string) => fallback) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  const rpcErrorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
      };
    }
    throw new Error('chaqiruv rad etilishi kutilgandi');
  };

  it('HQ — ota filialsiz 201, level 0', async () => {
    const res: any = await service.createBranch(
      { name: 'Bosh ofis', type: 'HQ', code: 'HQ' },
      ADMIN,
    );
    expect(res.statusCode).toBe(201);
    expect(res.data).toEqual(
      expect.objectContaining({ type: 'HQ', parent_id: null, level: 0 }),
    );
  });

  it.each([
    ['PICKUP', '7', 2],
    ['REGIONAL', '1', 1],
    ['HYBRID', '1', 1],
  ])(
    '%s — ota filial bilan 201, level = ota + 1',
    async (type, parentId, level) => {
      const res: any = await service.createBranch(
        { name: `ZZ ${type}`, type, code: `ZZ-${type}`, parent_id: parentId },
        ADMIN,
      );
      expect(res.statusCode).toBe(201);
      expect(res.data).toEqual(
        expect.objectContaining({ type, parent_id: parentId, level }),
      );
    },
  );

  it.each(['PICKUP', 'REGIONAL', 'HYBRID'])(
    "%s — parent_id '' (forma payloadi) aniq 400 'ota filial majburiy' beradi",
    async (type) => {
      const err = await rpcErrorOf(
        service.createBranch(
          { name: `ZZ ${type}`, type, code: `ZZ-${type}`, parent_id: '' },
          ADMIN,
        ),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: "HQ bo'lmagan filial uchun ota filial (parent_id) majburiy",
        }),
      );
      expect(branchRepo.save).not.toHaveBeenCalled();
    },
  );

  it("HQ — parent_id bilan 400 (HQ'ning ota filiali bo'lmaydi)", async () => {
    const err = await rpcErrorOf(
      service.createBranch(
        { name: 'Bosh ofis', type: 'HQ', code: 'HQ', parent_id: '7' },
        ADMIN,
      ),
    );
    expect(err).toEqual(expect.objectContaining({ statusCode: 400 }));
  });
});
