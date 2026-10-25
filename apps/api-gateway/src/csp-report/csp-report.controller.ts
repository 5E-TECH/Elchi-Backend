import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  PayloadTooLargeException,
  Post,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { json, type Request, type Response } from 'express';
import { Public } from '../auth/public.decorator';
import { resolveTrustedClientIp } from '../auth/client-ip-throttler.guard';
import {
  CSP_REPORT_BODY_LIMIT_BYTES,
  CSP_REPORT_CONTENT_TYPES,
  CSP_REPORT_THROTTLE,
  extractCspViolations,
} from './csp-report';

/**
 * Global body-parser (Nest: faqat `application/json` va urlencoded) bu
 * turlarni O'QIMAYDI — tana shu yerda, faqat shu marshrut uchun, kichik
 * chegara bilan o'qiladi. `inflate: false` — siqilgan tana (gzip) qabul
 * qilinmaydi (415): kichik siqilgan tana chegaradan katta bo'lib ochilmasin.
 */
const parseCspReportBody = json({
  type: [...CSP_REPORT_CONTENT_TYPES],
  limit: CSP_REPORT_BODY_LIMIT_BYTES,
  inflate: false,
  strict: true,
});

const MAX_USER_AGENT = 256;

function readCspReportBody(req: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    parseCspReportBody(req, req.res as Response, (error?: unknown) => {
      if (error) {
        reject(toHttpError(error));
        return;
      }
      resolve((req as { body?: unknown }).body);
    });
  });
}

/**
 * body-parser xatosi → aniq HTTP xato. Xabar O'ZIMIZNIKI: parser xatosida
 * tana parchasi (`err.body`) bo'ladi — u javobga chiqmasin.
 */
function toHttpError(error: unknown): Error {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 413) {
    return new PayloadTooLargeException(
      `CSP hisoboti ${CSP_REPORT_BODY_LIMIT_BYTES / 1024} KB dan katta`,
    );
  }
  if (status === 415) {
    return new UnsupportedMediaTypeException(
      "CSP hisoboti kodlanishi qo'llab-quvvatlanmaydi",
    );
  }
  return new BadRequestException("CSP hisobotini o'qib bo'lmadi");
}

/**
 * (KwodkKWY) `POST /csp-report` — brauzerlarning CSP buzilish hisobotlari.
 *
 * - `@Public()` — JWT yo'q (brauzer hisobotni token bilan yubormaydi).
 * - Per-IP chegara `CSP_REPORT_THROTTLE` (30/daqiqa, `CF-Connecting-IP`).
 * - Faqat `application/csp-report` va `application/reports+json`; boshqasi —
 *   415, tana > 32 KB — 413, buzuq JSON — 400.
 * - Javob doim BO'SH 204 — kiritilgan ma'lumot hech qachon qaytmaydi.
 * - Har (takrorlanmas) buzilish — bitta tuzilmali `warn` log qatori
 *   `event: "csp_violation"` (tozalangan maydonlar, `csp-report.ts`). Kuzatuv:
 *   `docker logs <gateway> | grep csp_violation`.
 * - RMQ/DB'ga hech narsa yuborilmaydi.
 */
@ApiTags('Security')
@Controller('csp-report')
export class CspReportController {
  private readonly logger = new Logger(CspReportController.name);

  @Public()
  @Throttle(CSP_REPORT_THROTTLE)
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'CSP buzilish hisoboti (brauzer yuboradi; report-uri / report-to) — KwodkKWY',
    description:
      'Autentifikatsiyasiz. `Content-Type: application/csp-report` (`{ "csp-report": { … } }`) yoki ' +
      '`application/reports+json` (`[{ "type": "csp-violation", "body": { … } }]`, boshqa turlar e\'tiborsiz). ' +
      "Tana ≤ 32 KB, per-IP 30/daqiqa. Javob doim bo'sh 204; buzilishlar faqat gateway logiga " +
      '(`event: "csp_violation"`, URL\'lar query\'siz) yoziladi.',
  })
  @ApiConsumes(...CSP_REPORT_CONTENT_TYPES)
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: 'object',
          properties: {
            'csp-report': {
              type: 'object',
              example: {
                'document-uri': 'https://elchipochta.uz/orders',
                'blocked-uri': 'https://api.qrserver.com/v1/create-qr-code/',
                'effective-directive': 'img-src',
                disposition: 'report',
              },
            },
          },
        },
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', example: 'csp-violation' },
              url: { type: 'string' },
              body: { type: 'object' },
            },
          },
        },
      ],
    },
  })
  @ApiNoContentResponse({ description: 'Qabul qilindi (tana bo‘sh)' })
  @ApiResponse({ status: 400, description: 'Buzuq JSON' })
  @ApiResponse({ status: 413, description: 'Tana 32 KB dan katta' })
  @ApiResponse({
    status: 415,
    description: 'Content-Type csp-report / reports+json emas',
  })
  @ApiTooManyRequestsResponse({ description: 'Per-IP chegara (30/daqiqa)' })
  async receive(@Req() req: Request): Promise<void> {
    // `null` — tanasiz so'rov (hech narsa yo'q), `false` — boshqa tur.
    const matched = req.is([...CSP_REPORT_CONTENT_TYPES]);
    if (matched === null) return;
    if (!matched) {
      throw new UnsupportedMediaTypeException(
        'Content-Type application/csp-report yoki application/reports+json bo‘lishi kerak',
      );
    }
    const body = await readCspReportBody(req);
    const { violations, ignored, dropped } = extractCspViolations(body);
    if (!violations.length && !dropped) return;

    const userAgent = String(req.headers['user-agent'] ?? '').slice(
      0,
      MAX_USER_AGENT,
    );
    const ip = resolveTrustedClientIp(req);
    for (const violation of violations) {
      this.logger.warn({
        msg: 'CSP violation',
        event: 'csp_violation',
        ...violation,
        user_agent: userAgent || null,
        ip,
      });
    }
    if (dropped) {
      this.logger.warn({
        msg: 'CSP report: chegaradan ortiq hisobotlar yozilmadi',
        event: 'csp_report_dropped',
        dropped,
        ignored,
        ip,
      });
    }
  }
}
