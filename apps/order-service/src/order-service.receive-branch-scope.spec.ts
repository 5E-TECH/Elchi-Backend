import { RpcException } from '@nestjs/microservices';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

/**
 * FILIAL DOIRASI — menejer va registrator faqat O'Z filialida amal bajaradi
 * (foydalanuvchi qarori 2026-09-10).
 *
 * Nega bu test muhim: `receiveNewOrders` faqat `order_id` ro'yxatini oladi va
 * ularni tizimga qabul qiladi. Chegara bo'lmasa, istalgan filial xodimi
 * boshqa filialning buyurtmasini o'z tizimiga tortib olishi mumkin edi —
 * mas'uliyat zanjiri (custody) va pul oqimi buzilardi.
 *
 * Qulflanadigan invariantlar:
 *   - superadmin/admin CHEKLANMAYDI;
 *   - menejer/registrator faqat o'z filiali buyurtmasini qabul qiladi;
 *   - begona buyurtma bo'lsa BUTUN so'rov rad etiladi (jimgina filtrlash yo'q);
 *   - filiali yo'q xodim HECH NIMA qabul qila olmaydi (fail-closed);
 *   - notanish rol rad etiladi.
 */

type Row = Record<string, any>;

function buildSvc(
  over: {
    orders?: Row[];
    branchId?: string | null;
    branchCallFails?: boolean;
  } = {},
) {
  const svc: any = Object.create(OrderLifecycleService.prototype);
  const branchCalls: Row[] = [];

  svc.orderRepo = {
    find: jest.fn(() => Promise.resolve(over.orders ?? [])),
  };
  svc.branchClient = {};
  svc.identityClient = {};
  svc.logisticsClient = {};
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };

  return { svc: svc as OrderLifecycleService, branchCalls, over };
}

/**
 * `rmqSend` modul funksiyasi — uni mock qilamiz, chunki filial ma'lumoti
 * branch-service'dan RMQ orqali keladi.
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rmqSend } = require('@app/common') as { rmqSend: jest.Mock };

const requester = (roles: string[], id = 'u1') => ({ id, roles });

describe('receiveNewOrders — filial doirasi', () => {
  beforeEach(() => {
    rmqSend.mockReset();
  });

  const scope = (svc: any, req: unknown) =>
    svc.resolveReceiveBranchScope(req as never);

  it('superadmin CHEKLANMAYDI (null qaytadi, filial so‘ralmaydi)', async () => {
    const { svc } = buildSvc();
    await expect(scope(svc, requester(['superadmin']))).resolves.toBeNull();
    expect(rmqSend).not.toHaveBeenCalled();
  });

  it('admin CHEKLANMAYDI', async () => {
    const { svc } = buildSvc();
    await expect(scope(svc, requester(['admin']))).resolves.toBeNull();
    expect(rmqSend).not.toHaveBeenCalled();
  });

  it('menejer uchun o‘z filiali qaytadi', async () => {
    const { svc } = buildSvc();
    rmqSend.mockResolvedValue({ data: { branch_id: 'branch-7' } });
    await expect(scope(svc, requester(['manager']))).resolves.toBe('branch-7');
  });

  it('registrator ham CHEKLANADI (avval cheklovsiz edi)', async () => {
    const { svc } = buildSvc();
    rmqSend.mockResolvedValue({ data: { branch_id: 'branch-3' } });
    await expect(scope(svc, requester(['registrator']))).resolves.toBe(
      'branch-3',
    );
  });

  it('FAIL-CLOSED: filiali yo‘q menejer rad etiladi', async () => {
    const { svc } = buildSvc();
    rmqSend.mockResolvedValue({ data: { branch_id: null } });
    await expect(scope(svc, requester(['manager']))).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('FAIL-CLOSED: branch-service javob bermasa ham cheklovsiz BO‘LMAYDI', async () => {
    const { svc } = buildSvc();
    rmqSend.mockResolvedValue(null);
    await expect(scope(svc, requester(['manager']))).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('notanish rol rad etiladi', async () => {
    const { svc } = buildSvc();
    await expect(scope(svc, requester(['courier']))).rejects.toBeInstanceOf(
      RpcException,
    );
    await expect(scope(svc, requester([]))).rejects.toBeInstanceOf(RpcException);
  });

  it('foydalanuvchi id‘si yo‘q bo‘lsa rad etiladi', async () => {
    const { svc } = buildSvc();
    await expect(
      scope(svc, { roles: ['manager'] }),
    ).rejects.toBeInstanceOf(RpcException);
  });
});

describe('receiveNewOrders — begona filial buyurtmasi', () => {
  beforeEach(() => {
    rmqSend.mockReset();
  });

  it('boshqa filial buyurtmasi bo‘lsa BUTUN so‘rov rad etiladi', async () => {
    const { svc } = buildSvc({
      orders: [
        { id: 'o1', branch_id: 'branch-7', customer_id: 'c1' },
        { id: 'o2', branch_id: 'branch-9', customer_id: 'c2' },
      ],
    });
    rmqSend.mockResolvedValue({ data: { branch_id: 'branch-7' } });

    await expect(
      svc.receiveNewOrders(['o1', 'o2'], undefined, requester(['manager'])),
    ).rejects.toBeInstanceOf(RpcException);

    // Jimgina filtrlab o'z filialinikini qabul qilib ketmasligi shart —
    // aks holda operator hammasi qabul qilindi deb o'ylardi.
    expect(rmqSend).toHaveBeenCalledTimes(1); // faqat filial so'rovi
  });

  it('hammasi o‘z filialida bo‘lsa doira TO‘SMAYDI', async () => {
    const { svc } = buildSvc({
      orders: [{ id: 'o1', branch_id: 'branch-7', customer_id: 'c1' }],
    });
    rmqSend.mockResolvedValue({ data: { branch_id: 'branch-7' } });

    // Filial tekshiruvidan o'tadi va keyingi bosqichga (mijoz tekshiruvi)
    // boradi — ya'ni doira sababli TO'XTAMAYDI.
    await expect(
      svc.receiveNewOrders(['o1'], undefined, requester(['manager'])),
    ).rejects.not.toThrow(/filial/i);
  });
});
