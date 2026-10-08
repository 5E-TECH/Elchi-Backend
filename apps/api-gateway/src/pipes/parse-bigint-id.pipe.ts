import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Bigint id (`/^[0-9]{1,19}$/`) — gateway chegarasida tekshiriladi.
 *
 * Tekshiruvsiz `GET /branches/<harf>` quyi servisda Postgres'ning
 * `invalid input syntax for type bigint` xatosiga aylanib, mijozga 500
 * qaytarardi (RghzFldr) — aslida bu so'rov xatosi, ya'ni 400. Qiymat SATR
 * holida qoladi: quyi servis uni o'zi bigint sifatida o'qiydi.
 */
const BIGINT_ID_RE = /^[0-9]{1,19}$/;

@Injectable()
export class ParseBigintIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!BIGINT_ID_RE.test(String(value ?? ''))) {
      throw new BadRequestException(
        `id musbat butun son bo'lishi kerak, keldi: ${String(value)}`,
      );
    }
    return String(value);
  }
}
