import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
  type PipeTransform,
} from '@nestjs/common';
import { translateValidationMessages } from '@app/common';
import type { CarrierPrincipal } from './auth/carrier-api-key.guard';
import {
  CarrierOrderStatusRequestDto,
  CarrierOrderStatusWithRollbackRequestDto,
  carrierStatusValidationMessage,
} from './dto/carrier.swagger.dto';
import { UzValidationPipe } from './validation/uz-validation.pipe';

/**
 * `POST /carrier/orders/{id}/status` TANASI — akkauntning yashirin rollback
 * ruxsatiga qarab tekshiriladi (egasi, 2026-11-14).
 *
 * MUAMMO. `rollback` ni kompaniyaga hali aytmaymiz: o'chiq akkaunt uni
 * yuborsa javob istalgan NOMA'LUM status (`sould`) bilan AYNAN bir xil
 * bo'lishi kerak — 400, ayni xabar (faqat sold, partly_sold, cancelled
 * sanaladi), boshqa maydon xatolari bilan birga ham. Global
 * `UzValidationPipe` so'rovni (akkauntni) ko'rmaydi, kontrollerdagi keyingi
 * tekshiruv esa farqni oshkor qilardi: `{status:'rollback', extraCost:1}` da
 * faqat `extraCost` xatosi chiqib, `rollback` "tanish" qiymat ekani bilinardi.
 *
 * YECHIM. Maxsus parametr dekoratori (global pipe `type: 'custom'` ni
 * tekshirmaydi — `validateCustomDecorators: false`) tana bilan
 * `req.carrier.rollback_enabled` ni oladi (guard'dan keyin, `FileInterceptor`
 * multipart'ni o'qib bo'lgach), `CarrierStatusBodyPipe` esa AYNI
 * `UzValidationPipe` (main.ts opsiyalari) bilan DTO klassini tanlab tekshiradi:
 * o'chiq — `CarrierOrderStatusRequestDto` (rollback = noma'lum qiymat), yoqiq —
 * `CarrierOrderStatusWithRollbackRequestDto`. Rad etish kontroller
 * chaqirilishidan OLDIN: buyurtma o'qilmaydi, `Idempotency-Key` hech qayerga
 * yetmaydi, RMQ amali va kassa yozuvi yo'q.
 */
export type CarrierStatusBodyInput = {
  body: unknown;
  rollbackEnabled: boolean;
};

/**
 * `main.ts` → `new UzValidationPipe({...})` bilan AYNI opsiyalar
 * (`carrier-rollback-toggle.spec.ts` matnini solishtiradi).
 */
export const CARRIER_STATUS_PIPE_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
} as const;

export class CarrierStatusBodyPipe implements PipeTransform<
  CarrierStatusBodyInput,
  Promise<CarrierOrderStatusRequestDto>
> {
  private readonly pipe = new UzValidationPipe({
    ...CARRIER_STATUS_PIPE_OPTIONS,
  });

  async transform(
    value: CarrierStatusBodyInput,
  ): Promise<CarrierOrderStatusRequestDto> {
    const metatype =
      value?.rollbackEnabled === true
        ? CarrierOrderStatusWithRollbackRequestDto
        : CarrierOrderStatusRequestDto;
    return (await this.pipe.transform(value?.body, {
      type: 'body',
      metatype,
      data: undefined,
    })) as CarrierOrderStatusRequestDto;
  }
}

const extractCarrierStatusBody = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CarrierStatusBodyInput => {
    const req = ctx
      .switchToHttp()
      .getRequest<{ body?: unknown; carrier?: CarrierPrincipal }>();
    return {
      body: req.body,
      // Faqat aniq `true` — principal yo'q / eski javob: o'chiq.
      rollbackEnabled: req.carrier?.rollback_enabled === true,
    };
  },
);

/** `@Body()` o'rnida — `CarrierStatusBodyPipe` bilan tekshirilgan DTO. */
export const CarrierStatusBody = (): ParameterDecorator =>
  extractCarrierStatusBody(undefined, new CarrierStatusBodyPipe());

/**
 * Pipe'dagi noma'lum `status` xatosi bilan AYNI 400 (konvert ham:
 * `{ message: string[], error, statusCode }`). Kontrollerdagi himoya
 * tekshiruvi uchun — pipe chetlab o'tilsa ham rollback o'chiq akkauntda
 * hech narsa bajarilmaydi.
 */
export function carrierStatusRejected(): BadRequestException {
  return new BadRequestException({
    message: translateValidationMessages([carrierStatusValidationMessage()]),
    error: 'Bad Request',
    statusCode: 400,
  });
}
