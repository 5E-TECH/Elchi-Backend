import { Body, Controller, Req } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import {
  CarrierAuthGatewayController,
  type CarrierAuthRequest,
} from './carrier-auth-gateway.controller';
import {
  CarrierGatewayController,
  type CarrierRequest,
} from './carrier-gateway.controller';
import type { CarrierQrOrderResult } from './carrier-olcha-compat';
import {
  CarrierApiAccess,
  CarrierAuthTokenRoute,
  CarrierQrOrderFindRoute,
} from './carrier-olcha-routes';
import type { CarrierAuthTokenResponseDto } from './dto/carrier.swagger.dto';

/**
 * OLCHA'DAGI KABI PREFIKSSIZ MANZILLAR (ega 2026-11-27: «Ha, qo'sh»).
 *
 * Olcha bilan ishlaydigan tizim FAQAT DOMENNI almashtirib ulanadi:
 *   https://api.olchamarket.uz/auth/token   → https://api.elchipochta.uz/auth/token
 *   https://api.olchamarket.uz/qrorder/find → https://api.elchipochta.uz/qrorder/find
 * Ya'ni baza manzili domen YOKI domen/carrier — ikkalasi ishlaydi.
 *
 * Bu yerda MANTIQ YO'Q: har metod `/carrier/*` dagi AYNI handlerni chaqiradi,
 * kirish / limit / xato filtri / Swagger — `carrier-olcha-routes.ts` dagi
 * umumiy dekoratorlar. Natijada:
 *  - `POST /auth/token` — kirishsiz, IP limiti, Olcha (Yii2) xato shakli;
 *    xodimlarning `AuthGatewayController` (`/auth/login` va h.k.) filtri va
 *    limiti bu yo'lga TEGMAYDI (boshqa klass, `auth/token` u yerda yo'q);
 *  - `POST /qrorder/find` — `CarrierApiKeyGuard` (Bearer yoki `X-Api-Key`),
 *    akkaunt limiti (`CarrierThrottlerGuard` kaliti endpointsiz — ikki manzil
 *    BITTA 120/min hisobda), `@Public` (xodim JWT'si — 401).
 *
 * `/v1/...` ham ochiq (`main.ts` URI versiyalash), boshqa `/carrier/*`
 * endpointlar prefikssiz OCHILMAYDI (faqat Olcha'da bor ikki yo'l).
 *
 * Kontrakt: docs/public/CARRIER_API.md §10.
 */
@ApiTags('Carrier')
@Controller()
export class CarrierOlchaRootGatewayController {
  constructor(private readonly moduleRef: ModuleRef) {}

  @CarrierAuthTokenRoute('root')
  token(
    @Body() body: Record<string, unknown>,
    @Req() req: CarrierAuthRequest,
  ): Promise<CarrierAuthTokenResponseDto> {
    return this.moduleRef.get(CarrierAuthGatewayController).token(body, req);
  }

  @CarrierApiAccess()
  @CarrierQrOrderFindRoute('root')
  qrOrderFind(
    @Body() body: Record<string, unknown>,
    @Req() req: CarrierRequest,
  ): Promise<CarrierQrOrderResult> {
    return this.moduleRef.get(CarrierGatewayController).qrOrderFind(body, req);
  }
}
