import { stripImageMetadata } from './image-metadata';

/** kiZgTybn — EXIF / XMP / matn bloklari tozalanadi, piksel baytlari o'zgarmaydi. */
describe('stripImageMetadata (kiZgTybn)', () => {
  const seg = (marker: number, payload: Buffer) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
  };

  it('JPEG: APP1 (EXIF/GPS), APP13, COM olib tashlanadi; APP0, DQT, SOS saqlanadi', () => {
    const app0 = seg(0xe0, Buffer.from('JFIF\0'));
    const exif = seg(0xe1, Buffer.from('Exif\0\0GPS 41.31N 69.24E'));
    const iptc = seg(0xed, Buffer.from('Photoshop 3.0'));
    const com = seg(0xfe, Buffer.from('comment'));
    const dqt = seg(0xdb, Buffer.alloc(65, 1));
    const sos = Buffer.concat([
      seg(0xda, Buffer.alloc(10, 2)),
      Buffer.from([1, 2, 3, 0xff, 0xd9]),
    ]);
    const input = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      app0,
      exif,
      iptc,
      com,
      dqt,
      sos,
    ]);
    const out = stripImageMetadata(input, 'image/jpeg') as Buffer;
    expect(out).not.toBeNull();
    expect(out.includes(Buffer.from('GPS'))).toBe(false);
    expect(out.includes(Buffer.from('Photoshop'))).toBe(false);
    expect(out.includes(Buffer.from('comment'))).toBe(false);
    expect(out).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, sos]),
    );
  });

  const pngChunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([
      len,
      Buffer.from(type, 'latin1'),
      data,
      Buffer.alloc(4),
    ]);
  };
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('PNG: eXIf / tEXt / iTXt olib tashlanadi, IHDR/IDAT/IEND saqlanadi', () => {
    const ihdr = pngChunk('IHDR', Buffer.alloc(13, 1));
    const idat = pngChunk('IDAT', Buffer.alloc(20, 3));
    const iend = pngChunk('IEND', Buffer.alloc(0));
    const input = Buffer.concat([
      PNG_SIG,
      ihdr,
      pngChunk('eXIf', Buffer.from('GPS secret')),
      pngChunk('tEXt', Buffer.from('Author\0me')),
      pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp')),
      idat,
      iend,
    ]);
    const out = stripImageMetadata(input, 'image/png') as Buffer;
    expect(out).toEqual(Buffer.concat([PNG_SIG, ihdr, idat, iend]));
  });

  it('WebP: EXIF / XMP chunk va VP8X bayroqlari tozalanadi, RIFF hajmi yangilanadi', () => {
    const chunk = (fourcc: string, data: Buffer) => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(data.length);
      const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
      return Buffer.concat([Buffer.from(fourcc, 'latin1'), size, data, pad]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x0c | 0x10; // EXIF + XMP + alpha
    const body = Buffer.concat([
      chunk('VP8X', vp8x),
      chunk('VP8 ', Buffer.alloc(11, 5)),
      chunk('EXIF', Buffer.from('GPS secret')),
      chunk('XMP ', Buffer.from('<x:xmpmeta/>')),
    ]);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(body.length + 4, 4);
    header.write('WEBP', 8, 'latin1');
    const out = stripImageMetadata(
      Buffer.concat([header, body]),
      'image/webp',
    ) as Buffer;
    expect(out.includes(Buffer.from('GPS'))).toBe(false);
    expect(out.includes(Buffer.from('xmpmeta'))).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20] & 0x0c).toBe(0);
    expect(out[20] & 0x10).toBe(0x10);
  });

  it('buzilgan tuzilma yoki qo‘llanmaydigan tur — null', () => {
    expect(
      stripImageMetadata(Buffer.from([0xff, 0xd8, 0x00]), 'image/jpeg'),
    ).toBeNull();
    expect(
      stripImageMetadata(
        Buffer.concat([PNG_SIG, Buffer.alloc(3)]),
        'image/png',
      ),
    ).toBeNull();
    expect(
      stripImageMetadata(Buffer.from('RIFF....WEBP'), 'image/webp'),
    ).toBeNull();
    expect(
      stripImageMetadata(Buffer.from('%PDF'), 'application/pdf'),
    ).toBeNull();
  });
});
