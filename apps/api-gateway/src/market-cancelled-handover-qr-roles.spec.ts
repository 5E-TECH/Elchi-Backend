/**
 * Skan auditi #43 (ega 2026-11-23): bekor buyurtmani marketga topshirishda
 * market QR talabi — sukut bo'yicha yoqiq; uni FAQAT superadmin/admin
 * o'chiradi yoki yoqadi. Sozlama endi haqiqatan ishlaydi (o'chirilsa topshirish
 * QR'siz), shuning uchun market o'zinikini o'zgartira olmaydi.
 */
import 'reflect-metadata';
import { Roles as RoleEnum } from '@app/common';
import { ApiGatewayController } from './api-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';

const handlerOf = (name: string): object =>
  Object.getOwnPropertyDescriptor(ApiGatewayController.prototype, name)
    ?.value as object;

describe('PATCH markets/:id/cancelled-handover-qr — kim o‘zgartiradi (#43)', () => {
  it('faqat SUPERADMIN va ADMIN (market roli yo‘q)', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      handlerOf('updateMarketCancelledHandoverQr'),
    ) as string[];

    expect(roles).toEqual([RoleEnum.SUPERADMIN, RoleEnum.ADMIN]);
    expect(roles).not.toContain(RoleEnum.MARKET);
  });
});

describe('POST markets — menejer QR talabini o‘chira olmaydi (#43)', () => {
  const callCreate = async (roles: string[]) => {
    const send = jest.fn(() => ({ pipe: () => ({}) }));
    const self = Object.create(ApiGatewayController.prototype) as Record<
      string,
      unknown
    >;
    self.identityClient = { send };
    self.resolveBranchAssignment = jest
      .fn()
      .mockResolvedValue({ branch_id: '7', branch: { type: 'HYBRID' } });
    await (
      self as unknown as {
        createMarket: (dto: unknown, req: unknown) => Promise<unknown>;
      }
    )
      .createMarket(
        { name: 'M', cancelled_handover_qr_required: false },
        { user: { sub: '5', roles } },
      )
      .catch(() => undefined);
    const payload = (send.mock.calls[0] as unknown[] | undefined)?.[1] as
      { dto?: Record<string, unknown> } | undefined;
    return payload?.dto;
  };

  it('admin — yuborgan qiymati o‘tadi', async () => {
    const dto = await callCreate([RoleEnum.ADMIN]);
    expect(dto?.cancelled_handover_qr_required).toBe(false);
  });

  it('menejer — qiymat yuborilmaydi (sukut: QR majburiy)', async () => {
    const dto = await callCreate([RoleEnum.MANAGER]);
    expect(dto).toBeDefined();
    expect(dto?.cancelled_handover_qr_required).toBeUndefined();
  });
});
