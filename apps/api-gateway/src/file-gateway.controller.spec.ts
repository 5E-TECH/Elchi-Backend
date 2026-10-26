import {
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { firstValueFrom, isObservable, of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { FileGatewayController } from './file-gateway.controller';
import {
  canonicalUploadFolder,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_VIDEO_BYTES,
  UPLOAD_ROLES,
} from './file-upload-policy';

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

  /**
   * (dgvwZasd A) `POST files/upload` — rol → papka oq ro'yxati, limit.
   * Ilgari istalgan rol (mijoz ham) istalgan papkaga, jumladan ommaviy
   * `products` ga 50 MB gacha yuklay olardi.
   */
  describe('uploadFile — rol/papka oq ro‘yxati va limit (dgvwZasd)', () => {
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const png = (size = 64) => {
      const b = Buffer.alloc(size);
      Buffer.from(PNG_SIG).copy(b);
      return { originalname: 'p.png', mimetype: 'image/png', buffer: b };
    };
    const mp4 = (size: number) => {
      const b = Buffer.alloc(size);
      b.write('ftyp', 4, 'latin1');
      return { originalname: 'v.mp4', mimetype: 'video/mp4', buffer: b };
    };
    const pdf = () => ({
      originalname: 'd.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 test'),
    });
    const upReq = (roles: string[], folder?: unknown) =>
      ({
        user: { roles, sub: 'u1' },
        body: folder === undefined ? {} : { folder },
      }) as any;
    const upload = async (
      controller: FileGatewayController,
      file: any,
      req: any,
    ) => {
      const out: unknown = await controller.uploadFile(file, req);
      return isObservable(out) ? firstValueFrom(out) : out;
    };

    it('route: JWT + RolesGuard, mijoz/investor/market rollari ro‘yxatda yo‘q', () => {
      const handler = (FileGatewayController.prototype as any).uploadFile;
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, handler);
      expect(roles).toEqual(expect.arrayContaining(['courier', 'manager']));
      for (const denied of [
        'customer',
        'investor',
        'market',
        'market_operator',
      ]) {
        expect(roles).not.toContain(denied);
      }
      expect(UPLOAD_ROLES).toEqual(roles);
    });

    it('⭐ kuryer `products` ga yuklay olmaydi (403), fayl yuborilmaydi', async () => {
      const { controller, fileClient } = makeController();
      await expect(
        upload(controller, png(), upReq(['courier'], 'products')),
      ).rejects.toThrow(ForbiddenException);
      expect(fileClient.send).not.toHaveBeenCalled();
    });

    it('mijoz handler darajasida ham hech qaysi papkaga yuklay olmaydi (403)', async () => {
      const { controller, fileClient } = makeController();
      for (const folder of ['products', 'proof', undefined]) {
        await expect(
          upload(controller, png(), upReq(['customer'], folder)),
        ).rejects.toThrow(ForbiddenException);
      }
      expect(fileClient.send).not.toHaveBeenCalled();
    });

    it('oq ro‘yxatda yo‘q papka — admin uchun ham 403', async () => {
      const { controller, fileClient } = makeController();
      await expect(
        upload(controller, png(), upReq(['admin'], 'expense')),
      ).rejects.toThrow(ForbiddenException);
      expect(fileClient.send).not.toHaveBeenCalled();
    });

    it('jonli oqim: kuryer/menejer `proof` ga yuklaydi, papka file-service’ga o‘tadi', async () => {
      for (const role of ['courier', 'manager']) {
        const { controller, fileClient } = makeController();
        await upload(controller, png(), upReq([role], 'proof'));
        expect(fileClient.send).toHaveBeenCalledWith(
          { cmd: 'file.upload' },
          expect.objectContaining({ folder: 'proof', mime_type: 'image/png' }),
        );
      }
    });

    it('papka kanonik shaklga keltiriladi (`Proof ` → `proof`, maxfiy prefiks)', async () => {
      const { controller, fileClient } = makeController();
      await upload(controller, png(), upReq(['courier'], ' Proof '));
      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.upload' },
        expect.objectContaining({ folder: 'proof' }),
      );
      expect(canonicalUploadFolder(undefined)).toBe('uploads');
      expect(canonicalUploadFolder('pro/../of')).toBe('proof');
    });

    it('admin `products` ga rasm yuklaydi, PDF esa ommaviy papkaga 400', async () => {
      const { controller, fileClient } = makeController();
      await upload(controller, png(), upReq(['admin'], 'products'));
      expect(fileClient.send).toHaveBeenCalledTimes(1);
      await expect(
        upload(controller, pdf(), upReq(['admin'], 'products')),
      ).rejects.toThrow(BadRequestException);
      expect(fileClient.send).toHaveBeenCalledTimes(1);
    });

    it('papka berilmasa (`uploads`) — faqat superadmin/admin', async () => {
      const { controller, fileClient } = makeController();
      await expect(
        upload(controller, png(), upReq(['courier'])),
      ).rejects.toThrow(ForbiddenException);
      await upload(controller, png(), upReq(['superadmin']));
      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.upload' },
        expect.objectContaining({ folder: 'uploads' }),
      );
    });

    it('limit: rasm 10 MB dan katta → 413; video 20 MB gacha (bot isboti) o‘tadi', async () => {
      const { controller, fileClient } = makeController();
      await expect(
        upload(
          controller,
          png(UPLOAD_MAX_FILE_BYTES + 1),
          upReq(['courier'], 'proof'),
        ),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(fileClient.send).not.toHaveBeenCalled();

      await upload(
        controller,
        mp4(15 * 1024 * 1024),
        upReq(['courier'], 'proof'),
      );
      expect(fileClient.send).toHaveBeenCalledTimes(1);

      await expect(
        upload(
          controller,
          mp4(UPLOAD_MAX_VIDEO_BYTES + 1),
          upReq(['courier'], 'proof'),
        ),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(fileClient.send).toHaveBeenCalledTimes(1);
    });

    it('`files/qr` va `files/pdf` endi rolli (xodimlar), mijoz yo‘q', () => {
      const proto = FileGatewayController.prototype as any;
      for (const name of ['generateQr', 'generatePdf']) {
        const roles: string[] = Reflect.getMetadata(ROLES_KEY, proto[name]);
        expect(roles).toEqual(['superadmin', 'admin', 'manager']);
      }
    });
  });
});
