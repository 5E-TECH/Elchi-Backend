/// <reference types="jest" />
import { RpcException } from '@nestjs/microservices';
import { OrderServiceService } from './order-service.service';

/**
 * CyCV4XHR — QOP (external_batch_token) bo'yicha a'zo posilkalar.
 *
 * BeePost qopni BITTA yorliq bilan chiqaradi; qop yorlig'i ORD-/BTB- prefiksiz
 * `external_batch_token` bo'lib keladi. Skaner uni `order.find_by_qr` bilan
 * izlab 404 olardi — qop umuman tanilmasdi. Bu metod qop tokenini a'zo
 * posilkalariga ochadi (gateway order 404'dan keyin shu yo'lga tushadi).
 */
function buildSvc(members: Record<string, unknown>[]) {
  const svc: any = Object.create(OrderServiceService.prototype);
  svc.orderRepo = { find: jest.fn(() => Promise.resolve(members)) };
  return svc;
}

describe('OrderServiceService.findBatchByExternalToken (CyCV4XHR)', () => {
  it('qop a`zolari topilsa `type=batch` shaklida qaytaradi', async () => {
    const svc = buildSvc([
      {
        id: '1',
        qr_code_token: 'p1',
        status: 'new',
        source: 'external',
        external_batch_token: 'QOP-1',
      },
      {
        id: '2',
        qr_code_token: 'p2',
        status: 'new',
        source: 'external',
        external_batch_token: 'QOP-1',
      },
    ]);

    const res: any = await svc.findBatchByExternalToken('QOP-1');

    expect(res.statusCode).toBe(200);
    expect(res.data.external_batch_token).toBe('QOP-1');
    expect(res.data.is_external_batch).toBe(true);
    expect(res.data.count).toBe(2);
    expect(res.data.members).toHaveLength(2);
    // external_batch_token + isDeleted:false bo'yicha qidirildi
    expect(svc.orderRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          external_batch_token: 'QOP-1',
          isDeleted: false,
        }),
      }),
    );
  });

  it('a`zo yo`q bo`lsa 404 (RpcException statusCode=404)', async () => {
    const svc = buildSvc([]);
    await expect(svc.findBatchByExternalToken('YOQ')).rejects.toBeInstanceOf(
      RpcException,
    );
    await svc.findBatchByExternalToken('YOQ').catch((e: any) => {
      expect(e.getError().statusCode).toBe(404);
    });
  });

  it('bo`sh token -> 404 va DB so`rovi UMUMAN qilinmaydi', async () => {
    const svc = buildSvc([]);
    await expect(svc.findBatchByExternalToken('   ')).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(svc.orderRepo.find).not.toHaveBeenCalled();
  });
});
