import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { of, throwError } from 'rxjs';
import { FileGatewayController } from './file-gateway.controller';
import { createFileLinkToken } from './file-link';
import { fileOwnerOf, fileOwnershipEnforced } from './file-ownership';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * (dgvwZasd B) Shaxsiy fayl egaligi reestri — gateway o'qish qoidasi.
 *
 * Ilgari (PENDING_ACTIONS §3): xodim rolidagi har kim istalgan filialning
 * `proof-` faylini ochardi, yuklovchining o'zi esa fayl buyurtmaga
 * biriktirilguncha uni ko'ra olmasdi. Reestrda YO'Q eski fayllar — eski qoida.
 */
describe('Fayl egaligi reestri — gateway (dgvwZasd B)', () => {
  const KEY = 'proof-1793046055000-uuid-p.png';
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
  const REGISTERED = {
    key: KEY,
    owner_id: '26',
    owner_role: 'courier',
    owner_branch_id: '5',
  };
  const ORDER = {
    order_id: '78',
    market_id: '37',
    courier_id: '26',
    holder_courier_id: null,
    branch_id: '5',
    holder_branch_id: '6',
    home_branch_id: '7',
  };

  const makeController = (opts: {
    record?: unknown;
    order?: unknown;
    hq?: string;
    branchOf?: Record<string, string>;
    recordError?: boolean;
  }) => {
    const fileClient = {
      send: jest.fn(({ cmd }: { cmd: string }) => {
        if (cmd === 'file.find_owner') {
          return opts.recordError
            ? throwError(() => new Error('db down'))
            : of({ data: opts.record ?? null });
        }
        if (cmd === 'file.read') {
          return of({
            data: {
              body_base64: PNG.toString('base64'),
              mime_type: 'image/png',
            },
          });
        }
        return of({ statusCode: 200, data: { url: 'u' } });
      }),
    };
    const orderClient = {
      send: jest.fn(() => of({ data: opts.order ?? null })),
    };
    const branchClient = {
      send: jest.fn(({ cmd }: { cmd: string }, payload: any) => {
        if (cmd === 'branch.find_hq') {
          return opts.hq ? of({ data: { id: opts.hq } }) : of({ data: null });
        }
        const branchId = opts.branchOf?.[payload.user_id];
        return of({ data: branchId ? { branch_id: branchId } : null });
      }),
    };
    const controller = new FileGatewayController(
      fileClient as any,
      orderClient as any,
      branchClient as any,
    );
    return { controller, fileClient, orderClient, branchClient };
  };

  const asUser = (
    roles: string[],
    sub: string,
    branch_id: string | null = null,
  ) => ({ user: { roles, sub, branch_id } });

  const makeRes = () => ({
    setHeader: jest.fn(),
    send: jest.fn((body: unknown) => body),
  });

  const cmds = (client: { send: jest.Mock }) =>
    client.send.mock.calls.map(([pattern]) => pattern.cmd);

  const readDenied = async (
    controller: FileGatewayController,
    req: unknown,
    key = KEY,
  ) => {
    const res = makeRes();
    await expect(
      controller.getFileContent(key, req as any, res as any),
    ).rejects.toThrow(ForbiddenException);
    expect(res.send).not.toHaveBeenCalled();
  };

  const readOk = async (
    controller: FileGatewayController,
    req: unknown,
    key = KEY,
  ) => {
    const res = makeRes();
    await controller.getFileContent(key, req as any, res as any);
    expect(res.send).toHaveBeenCalledWith(PNG);
  };

  beforeEach(() => {
    process.env.FILE_OWNERSHIP_ENFORCE = 'on';
  });

  afterAll(() => {
    delete process.env.FILE_OWNERSHIP_ENFORCE;
  });

  describe('FILE_OWNERSHIP_ENFORCE=on — reestrdagi fayl', () => {
    it('⭐ yuklovchi o‘z faylini buyurtmaga biriktirilmasdan oldin ham o‘qiydi', async () => {
      const { controller, orderClient } = makeController({
        record: REGISTERED,
      });
      await readOk(controller, asUser(['courier'], '26'));
      expect(orderClient.send).not.toHaveBeenCalled();
    });

    it('⭐ boshqa kuryer — 403, fayl o‘qilmaydi', async () => {
      const { controller, fileClient } = makeController({
        record: REGISTERED,
        order: ORDER,
      });
      await readDenied(controller, asUser(['courier'], '99'));
      expect(cmds(fileClient)).not.toContain('file.read');
    });

    it('buyurtma marketi va ushlab turgan kuryer o‘qiydi', async () => {
      const { controller } = makeController({
        record: REGISTERED,
        order: { ...ORDER, holder_courier_id: '44' },
      });
      await readOk(controller, asUser(['market'], '37'));
      await readOk(controller, asUser(['courier'], '44'));
    });

    it('boshqa market — 403; buyurtmaga biriktirilmagan fayl marketga berilmaydi', async () => {
      await readDenied(
        makeController({ record: REGISTERED, order: ORDER }).controller,
        asUser(['market'], '16'),
      );
      await readDenied(
        makeController({ record: REGISTERED }).controller,
        asUser(['market'], '37'),
      );
    });

    it('⭐ boshqa filial menejeri — 403 (ilgari istalgan filial ochardi)', async () => {
      const { controller } = makeController({
        record: REGISTERED,
        order: ORDER,
        hq: '1',
      });
      await readDenied(controller, asUser(['manager'], '50', '9'));
    });

    it.each([
      ['buyurtma filiali', '5'],
      ['ushlab turgan filial', '6'],
      ['uy filiali', '7'],
    ])('menejer: %s — o‘qiydi', async (_name, branch) => {
      const { controller } = makeController({
        record: { ...REGISTERED, owner_branch_id: null },
        order: ORDER,
      });
      await readOk(controller, asUser(['manager'], '50', branch));
    });

    it('yuklovchi filiali xodimi buyurtmasiz faylni ham o‘qiydi', async () => {
      const { controller } = makeController({ record: REGISTERED });
      await readOk(controller, asUser(['registrator'], '51', '5'));
    });

    it('yuklovchi tokenida filial yo‘q edi (bot) — filial reestr o‘qilganda aniqlanadi', async () => {
      const { controller, branchClient } = makeController({
        record: { ...REGISTERED, owner_branch_id: null },
        branchOf: { '26': '5' },
      });
      await readOk(controller, asUser(['manager'], '50', '5'));
      expect(branchClient.send).toHaveBeenCalledWith(
        { cmd: 'branch.user.find_by_user' },
        { user_id: '26', requester: { id: '26', roles: [] } },
      );
    });

    it('so‘rovchi tokenida filial yo‘q — branch-service’dan olinadi', async () => {
      const { controller } = makeController({
        record: REGISTERED,
        branchOf: { '50': '5' },
      });
      await readOk(controller, asUser(['operator'], '50'));
    });

    it('filiali umuman aniqlanmagan xodim — 403', async () => {
      const { controller } = makeController({
        record: { ...REGISTERED, owner_branch_id: null },
      });
      await readDenied(controller, asUser(['manager'], '50'));
    });

    it('HQ xodimi — hamma filial (HQ qo‘lidagi bekor qilinganlar)', async () => {
      const { controller } = makeController({
        record: REGISTERED,
        order: ORDER,
        hq: '1',
      });
      await readOk(controller, asUser(['registrator'], '52', '1'));
    });

    it('HQ aniqlanmasa (branch-service xatosi) — 403', async () => {
      const { controller, branchClient } = makeController({
        record: REGISTERED,
      });
      branchClient.send.mockImplementation(() =>
        throwError(() => new Error('down')),
      );
      await readDenied(controller, asUser(['registrator'], '52', '1'));
    });

    it('superadmin/admin reestrga so‘rov yubormaydi', async () => {
      for (const role of ['superadmin', 'admin']) {
        const { controller, fileClient } = makeController({
          record: REGISTERED,
        });
        await readOk(controller, asUser([role], '1'));
        expect(cmds(fileClient)).toEqual(['file.read']);
      }
    });

    it('mijoz/investor yuklovchi bo‘lsa ham rol darvozasidan o‘tmaydi', async () => {
      const { controller, fileClient } = makeController({
        record: { ...REGISTERED, owner_id: '26' },
      });
      await readDenied(controller, asUser(['customer'], '26'));
      await readDenied(controller, asUser(['investor'], '26'));
      expect(fileClient.send).not.toHaveBeenCalled();
    });

    it('imzolangan URL (`GET files/:key`) ham shu qoida bilan', async () => {
      const { controller, fileClient } = makeController({
        record: REGISTERED,
        order: ORDER,
      });
      await expect(
        controller.getFileUrl(KEY, asUser(['courier'], '99') as any),
      ).rejects.toThrow(ForbiddenException);
      expect(cmds(fileClient)).not.toContain('file.get_url');

      await controller.getFileUrl(KEY, asUser(['courier'], '26'));
      expect(cmds(fileClient)).toContain('file.get_url');
    });

    it('reestrni tekshirib bo‘lmasa — 503, eski qoidaga tushmaydi', async () => {
      const { controller, fileClient } = makeController({ recordError: true });
      await expect(
        controller.getFileContent(
          KEY,
          asUser(['manager'], '50', '9') as any,
          makeRes() as any,
        ),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(cmds(fileClient)).not.toContain('file.read');
    });
  });

  describe('reestrda YO‘Q eski fayl — eski qoida (kalit yoqiq)', () => {
    it('xodim (menejer) istalgan filial — avvalgidek o‘qiydi', async () => {
      const { controller } = makeController({ record: null, hq: '1' });
      await readOk(controller, asUser(['manager'], '50', '9'));
    });

    it('market/kuryer — faqat buyurtma ishtirokchisi', async () => {
      const { controller } = makeController({ record: null, order: ORDER });
      await readOk(controller, asUser(['market'], '37'));
      await readOk(controller, asUser(['courier'], '26'));
      await readDenied(controller, asUser(['market'], '16'));
    });

    it('egasi topilmagan eski fayl tor rollarga berilmaydi', async () => {
      const { controller } = makeController({ record: null });
      await readDenied(controller, asUser(['courier'], '26'));
    });

    it('`ai-` kaliti: reestrda yo‘q — xodim o‘qiydi, mijoz yo‘q', async () => {
      const { controller } = makeController({ record: null });
      await readOk(controller, asUser(['manager'], '50'), 'ai-1-x.png');
      await readDenied(controller, asUser(['customer'], '2'), 'ai-1-x.png');
    });
  });

  describe('kalit o‘chiq (sukut) — o‘qish butunlay eski qoida', () => {
    beforeEach(() => {
      delete process.env.FILE_OWNERSHIP_ENFORCE;
    });

    it('sukut: `off`', () => {
      expect(fileOwnershipEnforced()).toBe(false);
      process.env.FILE_OWNERSHIP_ENFORCE = ' ON ';
      expect(fileOwnershipEnforced()).toBe(true);
    });

    it('reestr so‘ralmaydi: boshqa filial menejeri avvalgidek o‘qiydi', async () => {
      const { controller, fileClient } = makeController({
        record: REGISTERED,
      });
      await readOk(controller, asUser(['manager'], '50', '9'));
      expect(cmds(fileClient)).toEqual(['file.read']);
    });

    it('yuklovchi kuryer buyurtmasiz fayl — avvalgidek 403', async () => {
      const { controller } = makeController({ record: REGISTERED });
      await readDenied(controller, asUser(['courier'], '26'));
    });
  });

  describe('smena/chek fayllari va imzolangan havola', () => {
    const SHIFT_KEY = 'shift-check-1793-uuid-balance.jpg';

    it('⭐ `files/signed/:token` reestrga qaramaydi — begona egali fayl ham ochiladi', async () => {
      process.env.ACCESS_TOKEN_KEY = 'x'.repeat(40);
      const { controller, fileClient, orderClient } = makeController({
        record: { ...REGISTERED, key: SHIFT_KEY, owner_id: '77' },
      });
      const token = createFileLinkToken(SHIFT_KEY) as string;
      const res = makeRes();

      await controller.getSignedFileContent(token, res as any);

      expect(res.send).toHaveBeenCalledWith(PNG);
      expect(cmds(fileClient)).toEqual(['file.read']);
      expect(orderClient.send).not.toHaveBeenCalled();
    });

    it('yaroqsiz token — 403, fayl o‘qilmaydi', async () => {
      process.env.ACCESS_TOKEN_KEY = 'x'.repeat(40);
      const { controller, fileClient } = makeController({});
      await expect(
        controller.getSignedFileContent('yaroqsiz', makeRes() as any),
      ).rejects.toThrow(ForbiddenException);
      expect(fileClient.send).not.toHaveBeenCalled();
    });

    it('smena fayli `GET files/:key` — yuklovchi menejerga ham avvalgidek 403 (faqat havola)', async () => {
      const { controller, fileClient } = makeController({
        record: { ...REGISTERED, key: SHIFT_KEY, owner_id: '50' },
      });
      await readDenied(controller, asUser(['manager'], '50', '5'), SHIFT_KEY);
      expect(fileClient.send).not.toHaveBeenCalled();
    });
  });

  describe('yuklashda egasi yuboriladi', () => {
    const png = () => {
      const buffer = Buffer.alloc(64);
      PNG.copy(buffer);
      return { originalname: 'p.png', mimetype: 'image/png', buffer };
    };

    it('`POST files/upload` — JWT dan owner (body’dan emas)', () => {
      const { controller, fileClient } = makeController({});
      void controller.uploadFile(png(), {
        user: { sub: '26', roles: ['courier'], branch_id: '5' },
        body: { folder: 'proof', owner: { id: '1' } },
      });
      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.upload' },
        expect.objectContaining({
          folder: 'proof',
          owner: { id: '26', role: 'courier', branch_id: '5' },
        }),
      );
    });

    it('sotuv/bekor isboti (multipart) — owner file.upload’ga o‘tadi', async () => {
      const controller: any = Object.create(OrderGatewayController.prototype);
      controller.fileClient = {
        send: jest.fn(() => of({ data: { key: 'proof-1' } })),
      };

      await expect(
        controller.uploadProofFile(png(), {
          sub: '26',
          roles: ['courier'],
          branch_id: '5',
        }),
      ).resolves.toEqual(['proof-1']);

      expect(controller.fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.upload' },
        expect.objectContaining({
          folder: 'proof',
          owner: { id: '26', role: 'courier', branch_id: '5' },
        }),
      );
    });

    it('smena rasmi va kassa cheki yuklashi ham owner uzatadi', () => {
      const source = readFileSync(
        join(__dirname, 'finance-gateway.controller.ts'),
        'utf8',
      );
      expect(source.match(/owner: fileOwnerOf\(req\.user\)/g)).toHaveLength(2);
    });

    it('fileOwnerOf: sub yo‘q — owner yo‘q; filial bo‘sh — null', () => {
      expect(fileOwnerOf(undefined)).toBeUndefined();
      expect(fileOwnerOf({ roles: ['courier'] })).toBeUndefined();
      expect(fileOwnerOf({ sub: 26, roles: [] })).toEqual({
        id: '26',
        role: null,
        branch_id: null,
      });
    });
  });
});
