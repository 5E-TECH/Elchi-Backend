import { BadRequestException } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import { firstValueFrom, timeout } from 'rxjs';

/** file-service `file.read` (base64 baytlar) — sukut 60 s. */
export const PRIVATE_FILE_READ_TIMEOUT_MS = 60_000;

/**
 * Maxfiy fayl baytlari (`file.read`) — umumiy kesh va bajarilishsiz.
 * `download` — rasm bo'lmagan fayl (hisobot PDF/XLSX) yangi oynada
 * sandbox ichida emas, yuklab olish sifatida ochiladi.
 *
 * Ruxsat CHAQIRUVCHIDA tekshiriladi: `GET files/:key/content`
 * (`assertCanAccessPrivateKey`), `GET files/signed/:token` (havola tokeni) va
 * (GykuOz8f) `GET orders/extra-costs/:id/proofs/:index` (so'rov ro'yxati bilan
 * AYNI ko'rish qoidasi, order-service). Sarlavhalar uchalasida bir xil.
 */
export async function sendPrivateFileBytes(
  fileClient: Pick<ClientProxy, 'send'>,
  key: string,
  res: Response,
  options: { download?: boolean; timeoutMs?: number } = {},
) {
  const response = await firstValueFrom(
    fileClient
      .send<{
        data?: { body_base64?: string; mime_type?: string };
      }>({ cmd: 'file.read' }, { key })
      .pipe(timeout(options.timeoutMs ?? PRIVATE_FILE_READ_TIMEOUT_MS)),
  );

  const bodyBase64 = response?.data?.body_base64;
  if (!bodyBase64 || typeof bodyBase64 !== 'string') {
    throw new BadRequestException("Faylni o'qib bo'lmadi");
  }

  const buffer = Buffer.from(bodyBase64, 'base64');
  const mimeType = response?.data?.mime_type ?? 'application/octet-stream';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(buffer.length));
  // Maxfiy dalil — umumiy (CDN/proksi) keshga tushmasin.
  res.setHeader('Cache-Control', 'private, max-age=300');
  // Yuklangan fayl hech qachon sahifa sifatida bajarilmasin.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (options.download) {
    const fileName = String(key).replace(/[^\w.-]/g, '_');
    res.setHeader(
      'Content-Disposition',
      mimeType.startsWith('image/')
        ? 'inline'
        : `attachment; filename="${fileName}"`,
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  return res.send(buffer);
}
