import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';

/**
 * JAVOB TANASIDAGI `statusCode` NI HTTP HOLATIGA KO'CHIRADI.
 *
 * ⚠️ Servislar `successRes(data, 202, 'Market tasdig'i kutilmoqda')` kabi
 * javob qaytaradi, lekin NestJS POST uchun sukut bo'yicha 201 yuborardi. HTTP
 * kodiga qaraydigan har qanday mijoz (frontend, hamkor integratsiyasi,
 * monitoring) "amal bajarildi" deb o'ylardi, holbuki tanada "tasdiq
 * kutilmoqda" (202) yozilgan va buyurtma o'zgarmagan edi.
 *
 * Xatolar bu yerga kelmaydi — ular `RpcException` bo'lib global filtrlar
 * orqali allaqachon tanadagi kod bilan qaytadi. Bu interceptor faqat oddiy
 * (throw qilinmagan) javobni tuzatadi; kod bo'lmasa yoki noto'g'ri bo'lsa
 * NestJS'ning o'z kodi qoladi.
 */
@Injectable()
export class BodyStatusCodeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((body: unknown) => {
        const code =
          body && typeof body === 'object'
            ? (body as { statusCode?: unknown }).statusCode
            : undefined;
        if (
          typeof code === 'number' &&
          Number.isInteger(code) &&
          code >= 100 &&
          code <= 599 &&
          !response.headersSent
        ) {
          response.status(code);
        }
        return body;
      }),
    );
  }
}
