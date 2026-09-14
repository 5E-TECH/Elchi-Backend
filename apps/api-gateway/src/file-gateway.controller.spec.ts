import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { FileGatewayController } from './file-gateway.controller';

// Audit P1: previously any authenticated user (any role) could mint a signed
// URL for OR delete ANY object by key — including private COD-evidence /
// expense-proof files. These tests lock in the hardened authorization.
//
// Audit S5: rolning o'zi ham yetarli emas edi — "market" rolidagi HAR KIM
// HAR QANDAY marketning dalilini ocha olardi. Endi maxfiy fayl so'ralganda
// uning egasi (dalil qaysi buyurtmaga biriktirilgan) tekshiriladi.
describe('FileGatewayController object-level access control', () => {
  const makeController = (owner: unknown = null) => {
    const fileClient = { send: jest.fn(() => of({ statusCode: 200 })) };
    const orderClient = { send: jest.fn(() => of({ data: owner })) };
    const controller = new FileGatewayController(
      fileClient as any,
      orderClient as any,
    );
    return { controller, fileClient, orderClient };
  };

  const reqWithRoles = (roles: string[], sub = 'u1') =>
    ({ user: { roles, sub } }) as any;

  describe('getFileUrl (signed URL)', () => {
    it('denies a signed URL for a private (proof/expense) key to low-trust roles', async () => {
      const { controller, fileClient } = makeController();

      await expect(
        controller.getFileUrl(
          'proof-123-video.mp4',
          reqWithRoles(['customer']),
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.getFileUrl(
          'expense-9-proof.pdf',
          reqWithRoles(['investor']),
        ),
      ).rejects.toThrow(ForbiddenException);

      // No RPC is issued when access is denied.
      expect(fileClient.send).not.toHaveBeenCalled();
    });

    it('allows a signed URL for a private key to staff/business roles', async () => {
      const { controller, fileClient } = makeController();

      await controller.getFileUrl(
        'proof-123-video.mp4',
        reqWithRoles(['admin']),
        600,
      );

      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.get_url' },
        { key: 'proof-123-video.mp4', expires_in: 600 },
      );
    });

    it('allows a signed URL for a non-sensitive (public-prefix) key to any authenticated role', async () => {
      const { controller, fileClient } = makeController();

      await controller.getFileUrl(
        'products-1-photo.png',
        reqWithRoles(['customer']),
      );

      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.get_url' },
        { key: 'products-1-photo.png', expires_in: undefined },
      );
    });

    it('boshqa marketning dalilini ochishga yo`l qo`ymaydi (S5)', async () => {
      // Fayl 'market-7' ning buyurtmasiga tegishli, so'rovchi esa 'market-9'.
      const { controller, fileClient } = makeController({
        order_id: '100',
        market_id: 'market-7',
        courier_id: 'courier-1',
      });

      await expect(
        controller.getFileUrl(
          'proof-123-video.mp4',
          reqWithRoles(['market'], 'market-9'),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(fileClient.send).not.toHaveBeenCalled();
    });

    it('o`z buyurtmasining dalilini ochishga ruxsat beradi (S5)', async () => {
      const { controller, fileClient } = makeController({
        order_id: '100',
        market_id: 'market-7',
        courier_id: 'courier-1',
      });

      await controller.getFileUrl(
        'proof-123-video.mp4',
        reqWithRoles(['market'], 'market-7'),
      );

      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.get_url' },
        { key: 'proof-123-video.mp4', expires_in: undefined },
      );
    });

    it('yetkazgan kuryer o`z dalilini ocha oladi (S5)', async () => {
      const { controller, fileClient } = makeController({
        order_id: '100',
        market_id: 'market-7',
        courier_id: 'courier-1',
      });

      await controller.getFileUrl(
        'proof-123-video.mp4',
        reqWithRoles(['courier'], 'courier-1'),
      );

      expect(fileClient.send).toHaveBeenCalled();
    });

    it('egasi topilmagan maxfiy faylni tor rollarga bermaydi (S5)', async () => {
      const { controller, fileClient } = makeController(null);

      await expect(
        controller.getFileUrl(
          'proof-orphan.mp4',
          reqWithRoles(['market'], 'market-7'),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(fileClient.send).not.toHaveBeenCalled();
    });
  });

  describe('deleteFile', () => {
    // Route-level authorization is enforced by @UseGuards(JwtAuthGuard,
    // RolesGuard) + @Roles(SUPERADMIN, ADMIN) (covered by roles.guard.spec.ts).
    // Here we only assert the handler forwards to the file service.
    it('forwards delete to file.delete', () => {
      const { controller, fileClient } = makeController();

      controller.deleteFile('expense-9-proof.pdf');

      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.delete' },
        { key: 'expense-9-proof.pdf' },
      );
    });
  });
});
