import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import {
  CatalogGatewayController,
  productImageFileName,
} from './catalog-gateway.controller';
import {
  CreateProductRequestDto,
  UpdateProductRequestDto,
} from './dto/catalog.swagger.dto';

/**
 * Mahsulotlar katalogi (7-tur, 2026-10-16):
 *   Aws1oApe — POST /product tanasi DTO KLASSI orqali: ortiqcha maydon 400;
 *   zRqDRLAZ — `price` create/update DTO'larida, catalog-service'ga uzatiladi;
 *   ugoDD9TT — rasm uchun tor ro'yxat (PNG/JPEG/WebP), PDF/XLSX 400, URL
 *              kengaytmasi haqiqiy turga mos, magic-byte darvozasi.
 */

type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, unknown]>;

const MARKET = { sub: '121', roles: ['market'] };

/** `main.ts` dagi global pipe bilan AYNI sozlama. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validateBody = (
  metatype: typeof CreateProductRequestDto | typeof UpdateProductRequestDto,
  body: Record<string, unknown>,
) => pipe.transform(body, { type: 'body', metatype });

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
]);
const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n');
const XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);

const setup = () => {
  const catalogSend: Send = jest.fn(() => of({ id: '1' }));
  const fileSend: Send = jest.fn((_pattern, payload) =>
    of({
      data: {
        key: `products-1-uuid-${(payload as { file_name: string }).file_name}`,
      },
    }),
  );
  const controller = new CatalogGatewayController(
    { send: catalogSend } as any,
    { send: fileSend } as any,
    { send: jest.fn() } as any,
  );
  return { controller, catalogSend, fileSend };
};

const req = {
  user: MARKET,
  protocol: 'https',
  get: (name: string) => (name === 'host' ? 'api.test' : undefined),
  headers: {},
};

const sentDto = (send: Send) =>
  (
    send.mock.calls.find(
      ([pattern]) => pattern.cmd === 'catalog.product.create',
    )?.[1] as { dto: Record<string, unknown> }
  )?.dto;

describe('Aws1oApe — POST /product tanasi DTO klassi (forbidNonWhitelisted)', () => {
  it('⭐ TC3: ortiqcha maydon (sku) → 400', async () => {
    await expect(
      validateBody(CreateProductRequestDto, { name: 'Olma', sku: 'ABC123' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('⭐ TC3 (eskirgan qismi): `price` endi DTO maydoni (zRqDRLAZ) — 400 emas, son bo`lib o`tadi', async () => {
    const dto = (await validateBody(CreateProductRequestDto, {
      name: 'Olma',
      price: '1000',
    })) as CreateProductRequestDto;
    expect(dto.price).toBe(1000);
  });

  it('name majburiy (DTO) → 400', async () => {
    await expect(
      validateBody(CreateProductRequestDto, { market_id: '1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('⭐ TC4 PATCH: UpdateProductRequestDto ham ortiqcha maydonni rad etadi, price qabul qilinadi', async () => {
    await expect(
      validateBody(UpdateProductRequestDto, { sku: 'X' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const dto = (await validateBody(UpdateProductRequestDto, {
      price: '99 000',
    })) as UpdateProductRequestDto;
    expect(dto.price).toBe(99000);
  });
});

describe('zRqDRLAZ — narx (price)', () => {
  it.each([
    ['125000', 125000],
    ['125000.50', 125000.5],
    [125000, 125000],
    ['', null],
    [null, null],
  ])('price %p → %p', async (input, expected) => {
    const dto = (await validateBody(CreateProductRequestDto, {
      name: 'Olma',
      price: input,
    })) as CreateProductRequestDto;
    expect(dto.price).toBe(expected);
  });

  it.each([['abc'], [-1], ['12.345']])(
    'noto`g`ri price %p → 400',
    async (input) => {
      await expect(
        validateBody(CreateProductRequestDto, { name: 'Olma', price: input }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('POST /product price ni catalog-service ga uzatadi; berilmasa uzatilmaydi', async () => {
    const { controller, catalogSend } = setup();
    await controller.create(
      undefined,
      { name: 'Olma', price: 125000 },
      req as any,
    );
    expect(sentDto(catalogSend)).toEqual({
      name: 'Olma',
      image_url: undefined,
      user_id: '121',
      price: 125000,
    });

    catalogSend.mockClear();
    await controller.create(undefined, { name: 'Nok' }, req as any);
    expect(sentDto(catalogSend)).not.toHaveProperty('price');
  });
});

describe('ugoDD9TT — mahsulot rasmi faqat PNG/JPEG/WebP', () => {
  const file = (originalname: string, mimetype: string, buffer: Buffer) => ({
    originalname,
    mimetype,
    buffer,
  });

  it.each([
    ['hisobot.pdf', 'application/pdf', PDF],
    [
      'narxlar.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      XLSX,
    ],
  ])(
    '⭐ %s → 400 o`zbekcha xabar, fayl yuklanmaydi, mahsulot yaratilmaydi',
    async (name, mime, buffer) => {
      const { controller, catalogSend, fileSend } = setup();
      const error: unknown = await controller
        .create(file(name, mime, buffer), { name: 'Olma' }, req as any)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(
        'Faqat PNG/JPEG/WebP rasm yuklash mumkin',
      );
      expect(fileSend).not.toHaveBeenCalled();
      expect(catalogSend).not.toHaveBeenCalled();
    },
  );

  it('⭐ webp → yuklanadi (image/webp)', async () => {
    const { controller, fileSend, catalogSend } = setup();
    await controller.create(
      file('rasm.webp', 'image/webp', WEBP),
      { name: 'Olma' },
      req as any,
    );
    expect(fileSend).toHaveBeenCalledWith(
      { cmd: 'file.upload' },
      expect.objectContaining({ mime_type: 'image/webp', folder: 'products' }),
    );
    expect(String(sentDto(catalogSend).image_url)).toMatch(/\.webp$/);
  });

  it('⭐ png → image_url .png bilan tugaydi (nomda kengaytma bo`lmasa ham)', async () => {
    const { controller, catalogSend } = setup();
    await controller.create(
      file('rasm', 'image/png', PNG),
      { name: 'Olma' },
      req as any,
    );
    expect(String(sentDto(catalogSend).image_url)).toMatch(
      /^https:\/\/api\.test\/files\/view\/.+\.png$/,
    );
  });

  it('⭐ kengaytmasi .png, mazmuni PDF → 400 (magic-byte darvozasi)', async () => {
    const { controller, fileSend } = setup();
    await expect(
      controller.create(
        file('rasm.png', 'image/png', PDF),
        { name: 'Olma' },
        req as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fileSend).not.toHaveBeenCalled();
  });

  it('PATCH /product/:id ham shu darvozadan o`tadi (PDF → 400)', async () => {
    const { controller, catalogSend } = setup();
    await expect(
      controller.update(
        '5',
        file('a.pdf', 'application/pdf', PDF),
        {},
        req as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(catalogSend).not.toHaveBeenCalled();
  });

  it.each([
    ['photo', 'image/png', 'photo.png'],
    ['photo.PNG', 'image/png', 'photo.PNG'],
    ['a.jpeg', 'image/jpeg', 'a.jpeg'],
    ['a.jpg', 'image/jpg', 'a.jpg'],
    ['x.pdf', 'image/png', 'x.png'],
    ['', 'image/webp', 'image.webp'],
  ])('productImageFileName(%p, %p) → %p', (name, mime, expected) => {
    expect(productImageFileName(name, mime)).toBe(expected);
  });
});
