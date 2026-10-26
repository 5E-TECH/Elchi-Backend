// ⚠️ Birinchi: env ApiGatewayModule import qilinishidan OLDIN (Joi tekshiruvi).
import './gateway-test-env';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { of } from 'rxjs';
import { createGatewayE2eApp, type MockClient } from './gateway-e2e.app';

/**
 * (dgvwZasd A) Fayl yuklash ruxsatlari — HAQIQIY ApiGatewayModule ustida HTTP
 * darajasida (global JwtAuthGuard, RolesGuard, multer limiti). Faqat RMQ
 * mijozlari mock.
 *
 * Qabul mezonlari: mijoz `products` ga yuklay olmaydi (403); limitlar
 * Swagger'da; `/files/qr`, `/files/pdf` rolli. Jonli yo'l (kuryer → `proof`)
 * avvalgidek ishlaydi.
 */
describe('POST /files/upload, /files/qr, /files/pdf — ruxsatlar (dgvwZasd)', () => {
  let app: INestApplication;
  let file: MockClient;
  const jwt = new JwtService({
    secret: process.env.ACCESS_TOKEN_KEY,
    signOptions: { expiresIn: '1h' },
  });
  // `sid` siz token — sessiya tekshiruvi (identity RPC) chaqirilmaydi.
  const bearer = (role: string) =>
    `Bearer ${jwt.sign({ sub: '9001', username: `t-${role}`, roles: [role] })}`;

  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);
  const mp4 = (size: number) => {
    const b = Buffer.alloc(size);
    b.write('ftyp', 4, 'latin1');
    return b;
  };

  beforeAll(async () => {
    const created = await createGatewayE2eApp((token, pattern) => {
      if (token === 'FILE') {
        return of({
          statusCode: 201,
          message: 'File uploaded',
          data: { key: `${pattern.cmd}-key` },
        });
      }
      return of({ statusCode: 200, data: null });
    });
    app = created.app;
    file = created.clients.get('FILE')!;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    file.send.mockClear();
  });

  const uploadCalls = () =>
    file.send.mock.calls.filter(([p]) => p?.cmd === 'file.upload');

  it('⭐ mijoz `products` ga yuklay olmaydi — 403, file-service chaqirilmaydi', async () => {
    const res = await request(app.getHttpServer())
      .post('/files/upload')
      .set('Authorization', bearer('customer'))
      .field('folder', 'products')
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
    expect(uploadCalls()).toHaveLength(0);
  });

  it('kuryer `products` ga — 403; `proof` ga — 201 (jonli FE/bot oqimi)', async () => {
    const denied = await request(app.getHttpServer())
      .post('/files/upload')
      .set('Authorization', bearer('courier'))
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' })
      .field('folder', 'products');
    expect(denied.status).toBe(403);
    expect(uploadCalls()).toHaveLength(0);

    // FE `uploadProofFile` tartibi: avval `file`, keyin `folder`.
    const ok = await request(app.getHttpServer())
      .post('/files/upload')
      .set('Authorization', bearer('courier'))
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' })
      .field('folder', 'proof');
    expect(ok.status).toBe(201);
    expect(ok.body?.data?.key).toBeTruthy();
    expect(uploadCalls()).toHaveLength(1);
    expect(uploadCalls()[0][1]).toEqual(
      expect.objectContaining({ folder: 'proof', mime_type: 'image/png' }),
    );
  });

  it('bot isbot videosi (15 MB) o‘tadi; 20 MB dan katta — 413 (multer)', async () => {
    const ok = await request(app.getHttpServer())
      .post('/files/upload')
      .set('Authorization', bearer('courier'))
      .field('folder', 'proof')
      .attach('file', mp4(15 * 1024 * 1024), {
        filename: 'v.mp4',
        contentType: 'video/mp4',
      });
    expect(ok.status).toBe(201);

    const tooBig = await request(app.getHttpServer())
      .post('/files/upload')
      .set('Authorization', bearer('courier'))
      .field('folder', 'proof')
      .attach('file', mp4(20 * 1024 * 1024 + 1), {
        filename: 'v.mp4',
        contentType: 'video/mp4',
      });
    expect(tooBig.status).toBe(413);
    expect(uploadCalls()).toHaveLength(1);
  });

  it('rasm 10 MB dan katta — 413', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const res = await request(app.getHttpServer())
      .post('/files/upload')
      .set('Authorization', bearer('manager'))
      .field('folder', 'proof')
      .attach('file', big, { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(uploadCalls()).toHaveLength(0);
  });

  it('`/files/qr` va `/files/pdf`: mijoz/kuryer 403, admin o‘tadi', async () => {
    for (const path of ['/files/qr', '/files/pdf']) {
      const body =
        path === '/files/qr' ? { text: 'x' } : { title: 't', content: 'c' };
      for (const role of ['customer', 'courier']) {
        const res = await request(app.getHttpServer())
          .post(path)
          .set('Authorization', bearer(role))
          .send(body);
        expect(res.status).toBe(403);
      }
      const ok = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', bearer('admin'))
        .send(body);
      expect(ok.status).toBe(201);
    }
    expect(file.send.mock.calls.map(([p]) => p?.cmd).filter(Boolean)).toEqual([
      'file.generate_qr',
      'file.generate_pdf',
    ]);
  });

  it('tokensiz — 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/files/upload')
      .field('folder', 'proof')
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });
});
