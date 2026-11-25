import {
  PayloadTooLargeException,
  type INestApplication,
} from '@nestjs/common';
import { json, type NextFunction, type Request, type Response } from 'express';

/**
 * `POST /export/old-mails.xlsx` tanasi. Gateway'ning umumiy JSON chegarasi —
 * Express sukuti 100 KB (~500 qator); eski pochtalar fayli esa 10 000 qatorgacha
 * (`OLD_MAILS_EXPORT_MAX_ROWS`). Bitta qator JSON'da ~190 bayt (kirillchada
 * ~250) → 10 000 qator ≈ 2–2,5 MB; chegara ikki barobar zaxira bilan. Boshqa
 * yo'llar chegarasi O'ZGARMAYDI.
 */
export const OLD_MAILS_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Versiyali yo'l ham (`main.ts` `enableVersioning`). */
export const OLD_MAILS_EXPORT_PATHS: string[] = [
  '/export/old-mails.xlsx',
  '/v1/export/old-mails.xlsx',
];

/**
 * ⚠️ `app.init()` dan (ya'ni `listen` dan) OLDIN chaqiriladi: shu yo'l tanasi
 * umumiy parserdan oldin o'qiladi (o'qilgan tanani u o'tkazib yuboradi).
 *
 * ⚠️ Parser nomlangan funksiyaga o'ralgan: Nest umumiy parserni qo'yishdan oldin
 * stekda `jsonParser` nomli qatlam bor-yo'qligini tekshiradi — `json()` o'zi
 * qo'yilsa, Nest umumiy parserni QO'YMASDI va boshqa hamma POST tanasiz qolardi.
 */
export function applyOldMailsBodyLimit(app: INestApplication): void {
  const parse = json({ limit: OLD_MAILS_BODY_LIMIT_BYTES });
  const oldMailsBodyParser = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    parse(req, res, (error?: unknown) => {
      const tooLarge =
        (error as { type?: unknown } | undefined)?.type === 'entity.too.large';
      next(
        tooLarge
          ? new PayloadTooLargeException(
              "Ro'yxat juda katta — filtrni toraytirib, qismlab yuklab oling",
            )
          : error,
      );
    });
  };
  app.use(OLD_MAILS_EXPORT_PATHS, oldMailsBodyParser);
}
