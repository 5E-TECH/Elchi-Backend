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

    it("HD5zOyBp #6: 'ai-' kaliti maxfiy — mijoz/investor imzolangan URL ololmaydi", async () => {
      const { controller, fileClient, orderClient } = makeController();
      const asUser = (roles: string[]) => ({ user: { roles, sub: 'u1' } });

      for (const role of ['customer', 'investor']) {
        await expect(
          controller.getFileUrl('ai-123-x.jpg', asUser([role])),
        ).rejects.toThrow(ForbiddenException);
      }
      // Rolsiz (bo'sh) token ham rad etiladi.
      await expect(
        controller.getFileUrl('ai-123-x.jpg', asUser([])),
      ).rejects.toThrow(ForbiddenException);

      expect(fileClient.send).not.toHaveBeenCalled();
      expect(orderClient.send).not.toHaveBeenCalled();
    });

    it("'ai-' kaliti xodim rollariga avvalgidek ochiq (admin)", async () => {
      const { controller, fileClient } = makeController();

      await controller.getFileUrl('ai-123-x.jpg', {
        user: { roles: ['admin'], sub: 'a1' },
      });

      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.get_url' },
        { key: 'ai-123-x.jpg', expires_in: undefined },
      );
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

  // YEVhU6XK: prod'da imzolangan URL MinIO'ning ichki manziliga ishora qiladi —
  // brauzer dalilni ocha olmaydi. Baytlar endi JWT bilan gateway orqali beriladi;
  // ruxsat imzolangan URL bilan AYNAN bir xil (rol + egalik).
  describe('getFileContent (YEVhU6XK — baytlar gateway orqali)', () => {
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

    const makeContentController = (owner: unknown = null) => {
      const fileClient = {
        send: jest.fn(() =>
          of({
            data: {
              body_base64: PNG.toString('base64'),
              mime_type: 'image/png',
            },
          }),
        ),
      };
      const orderClient = { send: jest.fn(() => of({ data: owner })) };
      const controller = new FileGatewayController(
        fileClient as any,
        orderClient as any,
      );
      return { controller, fileClient };
    };

    const makeRes = () => {
      const headers: Record<string, string> = {};
      const res = {
        setHeader: jest.fn((name: string, value: string) => {
          headers[name.toLowerCase()] = value;
        }),
        send: jest.fn((body: unknown) => body),
      };
      return { res, headers };
    };

    it('⭐ o`z buyurtmasining dalili — baytlar, to`g`ri tur va maxfiy kesh sarlavhalari', async () => {
      const { controller, fileClient } = makeContentController({
        order_id: '78',
        market_id: '37',
        courier_id: '26',
      });
      const { res, headers } = makeRes();

      await controller.getFileContent(
        'proof-1-abc.png',
        reqWithRoles(['market'], '37'),
        res as any,
      );

      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.read' },
        { key: 'proof-1-abc.png' },
      );
      expect(res.send).toHaveBeenCalledWith(PNG);
      expect(headers['content-type']).toBe('image/png');
      expect(headers['content-length']).toBe(String(PNG.length));
      expect(headers['cache-control']).toBe('private, max-age=300');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['content-security-policy']).toContain('sandbox');
    });

    it('kuryer o`zi yetkazgan buyurtma dalilini oladi', async () => {
      const { controller, fileClient } = makeContentController({
        order_id: '74',
        market_id: '37',
        courier_id: '26',
      });
      const { res } = makeRes();

      await controller.getFileContent(
        'proof-2-video.mp4',
        reqWithRoles(['courier'], '26'),
        res as any,
      );

      expect(fileClient.send).toHaveBeenCalled();
      expect(res.send).toHaveBeenCalled();
    });

    it('boshqa marketning dalili → 403, fayl o`qilmaydi', async () => {
      const { controller, fileClient } = makeContentController({
        order_id: '32',
        market_id: '16',
        courier_id: '26',
      });
      const { res } = makeRes();

      await expect(
        controller.getFileContent(
          'proof-3-x.png',
          reqWithRoles(['market'], '37'),
          res as any,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(fileClient.send).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
    });

    it('mijoz/investor maxfiy kalitni ololmaydi; egasiz dalil tor rolga berilmaydi', async () => {
      for (const roles of [['customer'], ['investor'], []]) {
        const { controller, fileClient } = makeContentController();
        await expect(
          controller.getFileContent(
            'proof-4-x.png',
            reqWithRoles(roles),
            makeRes().res as any,
          ),
        ).rejects.toThrow(ForbiddenException);
        expect(fileClient.send).not.toHaveBeenCalled();
      }
      const { controller } = makeContentController(null);
      await expect(
        controller.getFileContent(
          'proof-orphan.png',
          reqWithRoles(['market'], '37'),
          makeRes().res as any,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('xodim (superadmin) istalgan dalilni oladi', async () => {
      const { controller, fileClient } = makeContentController();
      const { res } = makeRes();

      await controller.getFileContent(
        'proof-5-x.png',
        reqWithRoles(['superadmin'], '1'),
        res as any,
      );

      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.read' },
        { key: 'proof-5-x.png' },
      );
      expect(res.send).toHaveBeenCalledWith(PNG);
    });

    it('route `files/:key/content` (frontend kontrakti) va JWT talab qilinadi', () => {
      const proto = FileGatewayController.prototype as unknown as Record<
        string,
        unknown
      >;
      const handler = proto.getFileContent;
      expect(Reflect.getMetadata('path', handler)).toBe('files/:key/content');
      expect(Reflect.getMetadata('isPublic', handler)).toBeUndefined();
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
