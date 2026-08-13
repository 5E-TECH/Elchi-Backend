import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { FileGatewayController } from './file-gateway.controller';

// Audit P1: previously any authenticated user (any role) could mint a signed
// URL for OR delete ANY object by key — including private COD-evidence /
// expense-proof files. These tests lock in the hardened authorization.
describe('FileGatewayController object-level access control', () => {
  const makeController = () => {
    const fileClient = { send: jest.fn(() => of({ statusCode: 200 })) };
    const controller = new FileGatewayController(fileClient as any);
    return { controller, fileClient };
  };

  const reqWithRoles = (roles: string[]) => ({ user: { roles } }) as any;

  describe('getFileUrl (signed URL)', () => {
    it('denies a signed URL for a private (proof/expense) key to low-trust roles', () => {
      const { controller, fileClient } = makeController();

      expect(() =>
        controller.getFileUrl(
          'proof-123-video.mp4',
          reqWithRoles(['customer']),
        ),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.getFileUrl(
          'expense-9-proof.pdf',
          reqWithRoles(['investor']),
        ),
      ).toThrow(ForbiddenException);

      // No RPC is issued when access is denied.
      expect(fileClient.send).not.toHaveBeenCalled();
    });

    it('allows a signed URL for a private key to staff/business roles', () => {
      const { controller, fileClient } = makeController();

      controller.getFileUrl(
        'proof-123-video.mp4',
        reqWithRoles(['admin']),
        600,
      );

      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.get_url' },
        { key: 'proof-123-video.mp4', expires_in: 600 },
      );
    });

    it('allows a signed URL for a non-sensitive (public-prefix) key to any authenticated role', () => {
      const { controller, fileClient } = makeController();

      controller.getFileUrl('products-1-photo.png', reqWithRoles(['customer']));

      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.get_url' },
        { key: 'products-1-photo.png', expires_in: undefined },
      );
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
